using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Numerics;
using Reader = Varia.Backend.Search.IndexFileContainer.PayloadReader;
using Writer = Varia.Backend.Search.IndexFileContainer.PayloadWriter;

namespace Varia.Backend.Search;

/// <summary>How a table's entries name one of its texts. A load charges a text by it as the read that made the table did (a
/// name must fit, a definition may be left out), and a load without children keeps only the texts with the first or the third.</summary>
[Flags]
internal enum TextUse : byte
{
    None = 0,
    /// <summary>The name or schema of an entry a read without children keeps.</summary>
    Name = 1,
    /// <summary>The name of a column, index, statistic or parameter, or a type's name or schema.</summary>
    ChildName = 2,
    /// <summary>The definition of an entry a read without children keeps.</summary>
    Definition = 4,
    /// <summary>The definition of a column (a computed column's expression).</summary>
    ChildDefinition = 8,
    /// <summary>Beside <see cref="Name"/>: something else named the text first (a column, a type, a definition), in entry order.
    /// A BigQuery read charges a text once, as whatever interned it first, so a load charges it as a detail too.</summary>
    DetailFirst = 16
}

/// <summary>One unit as <see cref="IndexFile"/> saves it: a read (<see cref="DatabaseIndex"/>) or the shared resource set, with
/// the flags a read may still change read once, so the file is one consistent picture of it.</summary>
internal sealed record IndexUnit(IndexUnitKind Kind, string Name, string? Dataset, ObjectTable Table, BigQueryFacts? Facts, int Modules, int Cut, int LeftOut, long Bytes,
    DateTime ReadAt, bool ChildrenLeftOut = false, bool DefinitionsLeftOut = false, bool Detailed = false, bool FailedPart = false, bool? CaseSensitive = null, bool DottedI = false,
    ResourceKey? Resource = null)
{
    public IndexProvider Provider => IndexFileUnit.ProviderOf(Kind);

    public static IndexUnit Of(DatabaseIndex read, IndexUnitKind kind) => new(kind, read.Database, read.Dataset, read.Table, read.Facts, read.Modules, read.Cut, read.LeftOut, read.Bytes,
        read.ReadAt, read.ChildrenLeftOut, read.DefinitionsLeftOut, read.Detailed, read.FailedPart, read.CaseSensitive, read.DottedI);

    public static IndexUnit Of(ResourceSet set, DateTime readAt) => new(IndexUnitKind.Resource, set.Key.Version, null, set.Table, null, set.Modules, set.Cut, set.LeftOut, set.Bytes,
        readAt, DefinitionsLeftOut: !set.Key.Definitions, Resource: set.Key);
}

/// <summary>What a load made of a file's body, before it becomes a <see cref="DatabaseIndex"/> or a shared set.</summary>
internal sealed record LoadedUnit(string Name, string? Dataset, ObjectTable Table, BigQueryFacts? Facts, int Modules, int Cut, int LeftOut, bool ChildrenLeftOut,
    bool DefinitionsLeftOut, bool Detailed, bool FailedPart, bool? CaseSensitive, bool DottedI, ResourceKey? Resource, byte[] Extra);

/// <summary>
/// An index file's content, inside the container's blocks (<see cref="IndexFileContainer"/>): the unit's own fields, the shapes
/// its entries name (by value: <see cref="ObjectShapes"/> ids are a process's own), its entries column by column, its
/// out-of-range dates, its <see cref="ObjectDetails"/>, BigQuery's facts, its texts, and the caller's opaque bytes. Lookup
/// arrays are not saved; a load builds none.
/// <code>
/// unit:     u16 flags | text name | (text dataset) | i32 modules, cut, left out |
///           (resource: i32 edition | i64 count | u8 has latest | i64 latest | i32 checksum)
/// shapes:   i32 n, each text kind | text folder | u8 has subtype | (text subtype)
/// texts:    i32 own strings | i32 strings | i32 own long definitions | i32 texts
/// entries:  i32 n | i32 how many are detail children | (u8 flags, u16 shape)[n] | i32 name[n] | schema[n] | owner[n] |
///           definition[n] | u32 modified[n]
/// dates:    i32 n, each i32 entry | i64 ticks and kind
/// details:  i32 types, typed, keys, key columns | ObjectDetails' arrays in its order
/// facts:    (BigQuery) i32 n, each i32 entry | i64 created | u16 flags | its optional values; then descriptions and shard groups
/// strings:  each, in id order: u8 use | i32 chars | UTF-16
/// long:     each long definition, in id order: u8 use | i32 chars | i32 bytes | i32 frame bytes | the frame | padding up to
///           a sixty-fourth of its bytes; all in stored blocks (a load refuses a compressed block here)
/// extra:    i32 n | bytes
/// </code>
/// A file numbers a table's texts afresh, by what a load does with them: the strings a read without children keeps (names,
/// and short definitions of what it keeps), the other strings, the long definitions it keeps, the others. So a text's form
/// and whether a load without children keeps it follow from its id, and nothing is held per text before the text itself is
/// read. The texts come last, so a load has charged everything that must fit (entries, details, facts) before the first
/// name, and every name before the first long definition, which may be left out. (A short definition is a string, among the
/// names; it is charged as the definition it is.)
/// <para>What a load holds it charges first. Entries: the file states how many a read without children leaves out
/// (<see cref="DetailChild"/>) and their flags and shapes come first, so the entries kept are charged before there is
/// anywhere to put them, and a load without children never holds the others (a bit each says which they were). Details: by
/// their counts. Texts: each as it is read, its slot before its place in the table, whether or not the text itself is kept
/// (while it reads them a load also holds, uncharged, a second copy of those places and two bytes for each: a little over
/// twice what it has charged for them, never more). What is not charged at all is bounded by <see cref="IndexFileLimits"/>
/// alone: the shapes, the out-of-range dates, the caller's extra bytes, a bit or two for each entry, and one text at a
/// time. BigQuery's facts are charged as a read charges them.</para>
/// A file is untrusted, and in clear text nothing below vouches for it, so <see cref="Load"/> checks everything a search or a
/// lookup relies on (<see cref="CheckEntries"/>, <see cref="CheckDetails"/>) before a table exists, and <see cref="Prepare"/>
/// refuses a unit those checks would refuse, so no file is written that cannot be loaded.
/// </summary>
internal static class IndexFileUnit
{
    private const ushort ChildrenLeftOutFlag = 1, DefinitionsLeftOutFlag = 2, DetailedFlag = 4, FailedPartFlag = 8, CaseKnownFlag = 16, CaseSensitiveFlag = 32, DottedIFlag = 64,
        FactsFlag = 128, DatasetFlag = 256, UnitFlags = 511;
    private const ushort FactDetailed = 1, FactWhole = 2, FactColumnsCut = 4, FactRows = 8, FactBytes = 16, FactListed = 32, FactPartitioning = 64, FactClustering = 128,
        FactSignature = 256, FactStale = 512, FactTextLeftOut = 1024, FactFlags = 2047;
    private const byte EntryFlags = ObjectTable.SystemFlag | ObjectTable.CutFlag | ObjectTable.ChildFlag;
    private const byte OwnUses = (byte)(TextUse.Name | TextUse.Definition), Uses5 = 31;
    /// <summary>What a read's charge may exceed its content's by: rows it charged and then left out (a child whose parent the
    /// login cannot see). Past as much again as the content, and this, a file's stated charge is not believed.</summary>
    private const long ChargeSlack = 64 * 1024;
    private const int Batch = 4096;
    private static readonly byte[] Zeros = new byte[Batch];

    public static IndexProvider ProviderOf(IndexUnitKind kind) => kind == IndexUnitKind.Dataset ? IndexProvider.BigQuery : IndexProvider.SqlServer;

    /// <summary>Whether a read without children leaves a child of this kind out: the result sets <see cref="ObjectSearchSql.Batch"/>
    /// drops with them, and a BigQuery table's columns.</summary>
    public static bool DetailChild(string kind) => kind is "column" or "index" or "statistic" or "parameter" or "bqColumn";

    private static IndexFileRefused Corrupt() => IndexFileContainer.Refused(IndexFileProblem.Corrupt);
    private static IndexFileRefused Budget() => IndexFileContainer.Refused(IndexFileProblem.Budget);

    private static readonly ConcurrentDictionary<(string, string, string?), ObjectShapes.Shape> shapes = new();

    /// <summary>A loaded shape, shared by the units that name it. A file's shapes take no process-wide id (a hostile file could
    /// use them all up): the loaded table keeps its own array of them. The cache is bounded; past it a shape is the table's own.</summary>
    private static ObjectShapes.Shape Shape(string kind, string folder, string? subtype)
    {
        if (shapes.TryGetValue((kind, folder, subtype), out var held)) return held;
        var made = new ObjectShapes.Shape(kind, folder, subtype);
        return shapes.Count < IndexFileLimits.Shapes ? shapes.GetOrAdd((kind, folder, subtype), made) : made;
    }

    // ---- Checks: the rules a table must keep for Search and the lookups, shared by the writer and the loader ----

    /// <summary>What a text id names: nothing (out of range, or a text the table gave back), a string, or a long definition.</summary>
    internal interface ITextForms
    {
        const int None = 0, String = 1, Long = 2;
        int Form(int id);
    }

    /// <summary>A file's texts: the strings first, then the long definitions.</summary>
    private readonly struct FileForms(int strings, int texts) : ITextForms
    {
        public int Form(int id) => (uint)id >= (uint)texts ? ITextForms.None : id < strings ? ITextForms.String : ITextForms.Long;
    }

    /// <summary>A table's texts as it holds them.</summary>
    private readonly struct TableForms(IReadOnlyList<object?> texts) : ITextForms
    {
        public int Form(int id) => (uint)id >= (uint)texts.Count ? ITextForms.None : texts[id] switch { null => ITextForms.None, string => ITextForms.String, _ => ITextForms.Long };
    }

    private static int CountsFor(int entries) => (int)Math.Min(int.MaxValue, 2L * entries + 4096);

    /// <summary>The counts a unit states of its definitions are within what its entries could account for (a read counts a
    /// definition for a row it may then leave out, so not exactly), so that sums of them never overflow.</summary>
    private static void CheckCounts(int modules, int cut, int leftOut, int entries)
    {
        var most = CountsFor(entries);
        if (modules < 0 || cut < 0 || leftOut < 0 || leftOut > cut || modules > most || cut > most) throw Corrupt();
    }

    /// <summary>Every entry's references are in range and of the right form: a name and a schema are strings, a definition any
    /// text held (none at all in a unit read without definitions); only a definition is cut; a child's parent is not a child and
    /// has a schema; the table a history table is shown below has one too and is itself shown below none, so no walk from an
    /// entry to its owner goes further than two steps; and a BigQuery dataset's children are its columns.</summary>
    public static void CheckEntries<TForms>(ReadOnlySpan<ObjectEntry> entries, TForms forms, int shapeCount, bool[] detailShape, bool dataset, bool definitions)
        where TForms : struct, ITextForms
    {
        for (var at = 0; at < entries.Length; at++)
        {
            ref readonly var entry = ref entries[at];
            if ((entry.Flags & ~EntryFlags) != 0 || entry.Shape >= shapeCount) throw Corrupt();
            if (forms.Form(entry.Name) != ITextForms.String) throw Corrupt();
            if (entry.Schema != -1 && forms.Form(entry.Schema) != ITextForms.String) throw Corrupt();
            if (entry.Definition != -1 && (!definitions || forms.Form(entry.Definition) == ITextForms.None)) throw Corrupt();
            if ((entry.Flags & ObjectTable.CutFlag) != 0 && entry.Definition < 0) throw Corrupt();
            var child = (entry.Flags & ObjectTable.ChildFlag) != 0;
            if (child && dataset && !detailShape[entry.Shape]) throw Corrupt();
            if (entry.Owner == -1)
            {
                if (child) throw Corrupt();
                continue;
            }
            if ((uint)entry.Owner >= (uint)entries.Length || entry.Owner == at) throw Corrupt();
            ref readonly var owner = ref entries[entry.Owner];
            // A parent, and the table a history table is shown below, has a schema: results name it by schema and name.
            if ((owner.Flags & ObjectTable.ChildFlag) != 0 || owner.Schema < 0 || !child && owner.Owner != -1) throw Corrupt();
        }
    }

    /// <summary>The details index only what the table holds, in the order <see cref="ObjectDetails"/> searches: a type's name
    /// and schema are strings, a typed entry's type exists, each entry is typed once and has one list of key columns, in entry
    /// order, a key's columns lie within the column list and all keys together name it at most twice over, and a key that names a table is a child (its own table is its parent).</summary>
    public static void CheckDetails<TForms>(ObjectDetails.Parts parts, ReadOnlySpan<ObjectEntry> entries, TForms forms) where TForms : struct, ITextForms
    {
        var types = parts.TypeName.Length;
        if (types > IndexFileLimits.Types || parts.KeyColumn.Length > IndexFileLimits.KeyColumns || parts.TypedAt.Length > IndexFileLimits.Objects
            || parts.KeyAt.Length > IndexFileLimits.Objects) throw IndexFileContainer.Refused(IndexFileProblem.Limits);
        for (var type = 0; type < types; type++)
        {
            if (forms.Form(parts.TypeName[type]) != ITextForms.String) throw Corrupt();
            if (parts.TypeSchema[type] != -1 && forms.Form(parts.TypeSchema[type]) != ITextForms.String) throw Corrupt();
            if ((parts.TypeFlags[type] & ~ObjectDetails.TypeFlagsMask) != 0) throw Corrupt();
        }
        var last = -1;
        for (var item = 0; item < parts.TypedAt.Length; item++)
        {
            var at = parts.TypedAt[item];
            if (at <= last || at >= entries.Length || parts.TypedType[item] >= types) throw Corrupt();
            last = at;
        }
        last = -1;
        long named = 0;
        for (var item = 0; item < parts.KeyAt.Length; item++)
        {
            var at = parts.KeyAt[item];
            if (at <= last || at >= entries.Length) throw Corrupt();
            last = at;
            var (from, count, referenced) = (parts.KeyFrom[item], parts.KeyCount[item], parts.KeyReferenced[item]);
            if (from < 0 || count < 0 || count > IndexFileLimits.KeyColumnsPerKey || (long)from + count > parts.KeyColumn.Length) throw Corrupt();
            // A read gives a key's columns to one other key at most (a primary or unique key's to its index), so the keys
            // name each column at most twice: many keys over one range would make a lookup build far more than was charged.
            if ((named += count) > 2L * parts.KeyColumn.Length) throw Corrupt();
            if (referenced == -1) continue;
            if ((uint)referenced >= (uint)entries.Length || (entries[at].Flags & ObjectTable.ChildFlag) == 0) throw Corrupt();
        }
    }

    /// <summary>Each text's use, from the entries and the details that name it (which <see cref="CheckEntries"/> and
    /// <see cref="CheckDetails"/> have passed), in the order a read names them: entry by entry, its name and schema, its
    /// definition, then its type.</summary>
    private static byte[] Uses(ReadOnlySpan<ObjectEntry> entries, bool[] detailShape, ObjectDetails.Parts? details, int texts)
    {
        var uses = new byte[texts];
        void Name(int id, bool detail)
        {
            ref var use = ref uses[id];
            if (detail) use |= (byte)TextUse.ChildName;
            else
            {
                if (use != 0 && (use & (byte)TextUse.Name) == 0) use |= (byte)TextUse.DetailFirst;
                use |= (byte)TextUse.Name;
            }
        }
        void Type(int type)
        {
            uses[details!.TypeName[type]] |= (byte)TextUse.ChildName;
            if (details.TypeSchema[type] >= 0) uses[details.TypeSchema[type]] |= (byte)TextUse.ChildName;
        }
        var typed = 0;
        for (var at = 0; at < entries.Length; at++)
        {
            ref readonly var entry = ref entries[at];
            var detail = (entry.Flags & ObjectTable.ChildFlag) != 0 && detailShape[entry.Shape];
            Name(entry.Name, detail);
            if (entry.Schema >= 0) Name(entry.Schema, detail);
            if (entry.Definition >= 0) uses[entry.Definition] |= (byte)(detail ? TextUse.ChildDefinition : TextUse.Definition);
            for (; details is not null && typed < details.TypedAt.Length && details.TypedAt[typed] <= at; typed++) Type(details.TypedType[typed]);
        }
        // The types no entry is typed by (a SQL Server read lists every type of the database).
        for (var type = 0; details is not null && type < details.TypeName.Length; type++) Type(type);
        return uses;
    }

    /// <summary>A text's use is one a text of its form can have, and is the one its place among the file's texts says: the
    /// texts a read without children keeps come first among the strings, and first among the long definitions.</summary>
    private static bool UseFits(byte use, bool longDefinition, bool own, bool dataset) =>
        use <= Uses5 && ((use & (byte)TextUse.DetailFirst) == 0 || (use & (byte)TextUse.Name) != 0)
        && (!longDefinition || (use & (byte)(TextUse.Name | TextUse.ChildName)) == 0) && (use & OwnUses) != 0 == own
        // A BigQuery read holds no text that nothing names (a SQL Server read may: the name of a row it then left out).
        && (use != 0 || !dataset);

    /// <summary>Whether a text of this use is one something is named by, and so no longer than a name may be.</summary>
    private static bool IsName(byte use) => (use & (byte)(TextUse.Name | TextUse.ChildName)) != 0;

    /// <summary>What a read sets together: details carried from another generation, or whose text was left out for memory, are
    /// an object's whose details were read and are not whole; and a read without definitions leaves no text out for memory.</summary>
    private static bool FactFits(in BigQueryObjectFacts fact, bool definitionsLeftOut) =>
        !(fact.Stale || fact.TextLeftOut) || fact.Detailed && !fact.Whole && !(fact.TextLeftOut && definitionsLeftOut);

    private static long FactBytesOf(in BigQueryObjectFacts fact) => BigQueryFacts.ObjectBytes + StringBytes(fact.Signature) + StringBytes(fact.Partitioning) + StringBytes(fact.Clustering);
    private static long ShardBytesOf(Varia.Backend.BigQueryShardsDto group) => BigQueryFacts.ShardBytes + StringBytes(group.Prefix) + StringBytes(group.First) + StringBytes(group.Last);
    private static long DescriptionBytesOf(string description) => BigQueryFacts.DescriptionBytes + IndexMemory.StringBytes(description.Length);
    private static long StringBytes(string? value) => value is null ? 0 : IndexMemory.StringBytes(value.Length);

    // ---- Writing ----

    /// <summary>What the unit's table and facts need of the format, worked out once before anything is written.</summary>
    /// <param name="TextIds">Each of the table's texts' id in the file (-1 for a text the table gave back, which is not written).</param>
    /// <param name="Order">The table's text for each id of the file, and <paramref name="Uses"/> its use.</param>
    /// <param name="Charge">The charge the header states: the unit's, kept within what a load believes.</param>
    internal sealed record Plan(int[] TextIds, int[] Order, byte[] Uses, int OwnStrings, int Strings, int OwnLong, long Charge, ObjectShapes.Shape[] Shapes, ushort[] ShapeIds,
        int DetailEntries, ObjectDetails.Parts? Details, KeyValuePair<int, DateTime>[] Dates, KeyValuePair<int, BigQueryObjectFacts>[] Facts, KeyValuePair<int, string>[] Descriptions,
        KeyValuePair<int, Varia.Backend.BigQueryShardsDto>[] Shards);

    /// <summary>Checks <paramref name="unit"/> against the format's limits and rules: refused as Limits or Unsupported, so that
    /// whatever is written loads.</summary>
    public static Plan Prepare(IndexUnit unit, int extraBytes)
    {
        static IndexFileRefused Limits() => IndexFileContainer.Refused(IndexFileProblem.Limits);
        var table = unit.Table;
        var entries = table.Entries;
        var texts = table.Texts;
        var resource = unit.Kind == IndexUnitKind.Resource;
        var dataset = unit.Kind == IndexUnitKind.Dataset;
        if (entries.Length > (resource ? IndexFileLimits.ResourceObjects : IndexFileLimits.Objects) || texts.Count > IndexFileLimits.Texts || extraBytes > IndexFileLimits.ExtraBytes
            || unit.Name.Length > IndexFileLimits.NameChars || unit.Dataset is { Length: > IndexFileLimits.NameChars }) throw Limits();
        try
        {
            if (unit.Kind is < IndexUnitKind.Database or > IndexUnitKind.Resource || resource != unit.Resource is not null || dataset != (unit.Dataset is not null) || dataset != (unit.Facts is not null)
                || unit.Detailed && (!dataset || unit.ChildrenLeftOut) || resource && (unit.ChildrenLeftOut || unit.FailedPart || unit.CaseSensitive is not null || unit.DottedI)
                || unit.ReadAt.Kind != DateTimeKind.Utc) throw Corrupt();
            CheckCounts(unit.Modules, unit.Cut, unit.LeftOut, entries.Length);
            // The shapes the entries name, numbered in the order they first appear.
            var all = table.Shapes;
            var local = new int[all.Count];
            Array.Fill(local, -1);
            var used = new List<ObjectShapes.Shape>();
            foreach (ref readonly var entry in entries)
            {
                if (entry.Shape >= all.Count) throw Corrupt();
                if (local[entry.Shape] >= 0) continue;
                var shape = all[entry.Shape];
                if (used.Count == IndexFileLimits.Shapes || shape.Kind.Length > IndexFileLimits.ShapeChars || shape.Folder.Length > IndexFileLimits.ShapeChars
                    || shape.Subtype is { Length: > IndexFileLimits.ShapeChars }) throw Limits();
                local[entry.Shape] = used.Count;
                used.Add(shape);
            }
            foreach (var text in texts)
                if (text is not null && DefinitionText.Length(text) > IndexFileLimits.TextChars) throw Limits();
            if ((table.Dates?.Count ?? 0) > IndexFileLimits.Dates) throw Limits();
            var detailShape = new bool[all.Count];
            for (var id = 0; id < detailShape.Length; id++) detailShape[id] = DetailChild(all[id].Kind);
            var forms = new TableForms(texts);
            CheckEntries(entries, forms, all.Count, detailShape, dataset, !unit.DefinitionsLeftOut);
            var details = table.Details?.ToParts();
            if (details is not null) CheckDetails(details, entries, forms);
            var detailEntries = 0;
            foreach (ref readonly var entry in entries)
                if ((entry.Flags & ObjectTable.ChildFlag) != 0 && detailShape[entry.Shape]) detailEntries++;

            // The file's text ids: the strings a read without children keeps, the other strings, the long definitions it
            // keeps, the others; each group in the table's order. A text the table gave back names nothing and is not written.
            var uses = Uses(entries, detailShape, details, texts.Count);
            var textIds = new int[texts.Count];
            Span<int> groups = stackalloc int[4];
            int Group(int id) => texts[id] is string ? (uses[id] & OwnUses) != 0 ? 0 : 1 : (uses[id] & (byte)TextUse.Definition) != 0 ? 2 : 3;
            for (var id = 0; id < textIds.Length; id++)
            {
                if (texts[id] is null ? uses[id] != 0 : texts[id] is not string && IsName(uses[id]) || uses[id] == 0 && dataset) throw Corrupt();
                if (texts[id] is string named && IsName(uses[id]) && named.Length > IndexFileLimits.NameTextChars) throw Limits();
                if (texts[id] is not null) groups[Group(id)]++;
            }
            var (ownStrings, strings, ownLong) = (groups[0], groups[0] + groups[1], groups[2]);
            Span<int> next = [0, ownStrings, strings, strings + ownLong];
            var order = new int[strings + ownLong + groups[3]];
            var fileUses = new byte[order.Length];
            for (var id = 0; id < textIds.Length; id++)
            {
                textIds[id] = texts[id] is null ? -1 : next[Group(id)]++;
                if (textIds[id] < 0) continue;
                order[textIds[id]] = id;
                fileUses[textIds[id]] = uses[id];
            }

            var dates = (table.Dates ?? new Dictionary<int, DateTime>()).OrderBy(pair => pair.Key).ToArray();
            var elsewhere = 0;
            foreach (ref readonly var entry in entries)
                if (entry.Modified == uint.MaxValue) elsewhere++;
            if (elsewhere != dates.Length) throw Corrupt();
            foreach (var (at, _) in dates)
                if ((uint)at >= (uint)entries.Length || entries[at].Modified != uint.MaxValue) throw Corrupt();
            var facts = unit.Facts?.Objects.OrderBy(pair => pair.Key).ToArray() ?? [];
            var descriptions = unit.Facts?.Descriptions.OrderBy(pair => pair.Key).ToArray() ?? [];
            var shards = unit.Facts?.ShardGroups.OrderBy(pair => pair.Key).ToArray() ?? [];
            // A unit read without its children holds none of what a load without children leaves out.
            if (unit.ChildrenLeftOut && (detailEntries != 0 || details is not null || descriptions.Length != 0)) throw Corrupt();
            static bool Long(string? value) => value is { Length: > IndexFileLimits.FactChars };
            foreach (var (at, fact) in facts)
            {
                if ((uint)at >= (uint)entries.Length || (entries[at].Flags & ObjectTable.ChildFlag) != 0 || !FactFits(fact, unit.DefinitionsLeftOut)) throw Corrupt();
                if (Long(fact.Signature) || Long(fact.Partitioning) || Long(fact.Clustering)) throw Limits();
            }
            foreach (var (at, description) in descriptions)
            {
                if ((uint)at >= (uint)entries.Length || (entries[at].Flags & ObjectTable.ChildFlag) == 0 || !detailShape[entries[at].Shape]) throw Corrupt();
                if (Long(description)) throw Limits();
            }
            foreach (var (at, group) in shards)
            {
                if ((uint)at >= (uint)entries.Length || (entries[at].Flags & ObjectTable.ChildFlag) != 0 || group.Count < 0) throw Corrupt();
                if (Long(group.Prefix) || Long(group.First) || Long(group.Last)) throw Limits();
            }
            var ids = new ushort[all.Count];
            for (var id = 0; id < ids.Length; id++) ids[id] = (ushort)Math.Max(0, local[id]);
            // What the content costs, as a load will work it out. A read's charge is that and what it charged for rows it then
            // left out: a charge below its content is no read's, and one far above it (a read that failed part way, with most
            // of its rows still waiting for their parent) is stated as the most a load believes.
            var whole = entries.Length * IndexMemory.RecordBytes + order.Length * IndexMemory.SlotBytes + (table.Details?.Bytes ?? 0) + facts.Sum(pair => FactBytesOf(pair.Value))
                + descriptions.Sum(pair => DescriptionBytesOf(pair.Value)) + shards.Sum(pair => ShardBytesOf(pair.Value));
            if (resource ? unit.Bytes != entries.Length * IndexMemory.RecordBytes + (table.Details?.Bytes ?? 0) : unit.Bytes < whole) throw Corrupt();
            var charge = resource ? unit.Bytes : Math.Min(unit.Bytes, 2 * whole + ChargeSlack);
            return new(textIds, order, fileUses, ownStrings, strings, ownLong, charge, [.. used], ids, detailEntries, details, dates, facts, descriptions, shards);
        }
        catch (IndexFileRefused refused) when (refused.Problem == IndexFileProblem.Corrupt)
        {
            throw IndexFileContainer.Refused(IndexFileProblem.Unsupported);
        }
    }

    public static void Write(Writer writer, IndexUnit unit, Plan plan, ReadOnlySpan<byte> extra, CancellationToken token)
    {
        var table = unit.Table;
        var entries = table.Entries;
        var textIds = plan.TextIds;
        int Id(int id) => id < 0 ? id : textIds[id];
        writer.UInt16((ushort)((unit.ChildrenLeftOut ? ChildrenLeftOutFlag : 0) | (unit.DefinitionsLeftOut ? DefinitionsLeftOutFlag : 0) | (unit.Detailed ? DetailedFlag : 0)
            | (unit.FailedPart ? FailedPartFlag : 0) | (unit.CaseSensitive is not null ? CaseKnownFlag : 0) | (unit.CaseSensitive == true ? CaseSensitiveFlag : 0)
            | (unit.DottedI ? DottedIFlag : 0) | (unit.Facts is not null ? FactsFlag : 0) | (unit.Dataset is not null ? DatasetFlag : 0)));
        writer.Text(unit.Name);
        if (unit.Dataset is { } dataset) writer.Text(dataset);
        writer.Int32(unit.Modules);
        writer.Int32(unit.Cut);
        writer.Int32(unit.LeftOut);
        if (unit.Resource is { } key)
        {
            writer.Int32(key.Edition);
            writer.Int64(key.Count);
            writer.Byte(key.Latest is null ? (byte)0 : (byte)1);
            writer.Int64(key.Latest is { } latest ? Pack(latest) : 0);
            writer.Int32(key.Checksum);
        }

        writer.Int32(plan.Shapes.Length);
        foreach (var shape in plan.Shapes)
        {
            writer.Text(shape.Kind);
            writer.Text(shape.Folder);
            writer.Byte(shape.Subtype is null ? (byte)0 : (byte)1);
            if (shape.Subtype is { } subtype) writer.Text(subtype);
        }

        writer.Int32(plan.OwnStrings);
        writer.Int32(plan.Strings);
        writer.Int32(plan.OwnLong);
        writer.Int32(plan.Order.Length);

        writer.Int32(entries.Length);
        writer.Int32(plan.DetailEntries);
        var triples = new byte[3 * Batch];
        for (var from = 0; from < entries.Length; from += Batch)
        {
            var run = entries.Slice(from, Math.Min(Batch, entries.Length - from));
            for (var at = 0; at < run.Length; at++)
            {
                triples[3 * at] = run[at].Flags;
                BinaryPrimitives.WriteUInt16LittleEndian(triples.AsSpan(3 * at + 1), plan.ShapeIds[run[at].Shape]);
            }
            writer.Bytes(triples.AsSpan(0, 3 * run.Length));
        }
        var values = new int[Batch];
        for (var column = 0; column < 5; column++)
            for (var from = 0; from < entries.Length; from += Batch)
            {
                var run = entries.Slice(from, Math.Min(Batch, entries.Length - from));
                for (var at = 0; at < run.Length; at++)
                    values[at] = column switch { 0 => Id(run[at].Name), 1 => Id(run[at].Schema), 2 => run[at].Owner, 3 => Id(run[at].Definition), _ => unchecked((int)run[at].Modified) };
                writer.Int32s(values.AsSpan(0, run.Length));
            }
        token.ThrowIfCancellationRequested();

        writer.Int32(plan.Dates.Length);
        foreach (var (at, date) in plan.Dates)
        {
            writer.Int32(at);
            writer.Int64(Pack(date));
        }

        var details = plan.Details;
        writer.Int32(details?.TypeName.Length ?? 0);
        writer.Int32(details?.TypedAt.Length ?? 0);
        writer.Int32(details?.KeyAt.Length ?? 0);
        writer.Int32(details?.KeyColumn.Length ?? 0);
        if (details is not null)
        {
            writer.Int32s([.. details.TypeName.Select(Id)]);
            writer.Int32s([.. details.TypeSchema.Select(Id)]);
            writer.Int32s(details.TypeId);
            writer.Bytes(details.TypeSystem);
            writer.Bytes(details.TypeFlags);
            writer.Int32s(details.TypedAt);
            writer.UInt16s(details.TypedType);
            writer.Int16s(details.TypedLength);
            writer.Bytes(details.TypedPrecision);
            writer.Bytes(details.TypedScale);
            writer.Int16s(details.TypedOrdinal);
            writer.Bytes(details.TypedFlags);
            writer.Int32s(details.KeyAt);
            writer.Int32s(details.KeyFrom);
            writer.Int16s(details.KeyCount);
            writer.Int32s(details.KeyReferenced);
            writer.Int16s(details.KeyColumn);
            writer.Int16s(details.KeyOther);
            writer.Bytes(details.KeyColumnFlags);
        }
        token.ThrowIfCancellationRequested();

        if (unit.Facts is not null)
        {
            writer.Int32(plan.Facts.Length);
            foreach (var (at, fact) in plan.Facts)
            {
                writer.Int32(at);
                writer.Int64(fact.Created);
                writer.UInt16((ushort)((fact.Detailed ? FactDetailed : 0) | (fact.Whole ? FactWhole : 0) | (fact.ColumnsCut ? FactColumnsCut : 0) | (fact.Rows is not null ? FactRows : 0)
                    | (fact.Bytes is not null ? FactBytes : 0) | (fact.Listed is not null ? FactListed : 0) | (fact.Partitioning is not null ? FactPartitioning : 0)
                    | (fact.Clustering is not null ? FactClustering : 0) | (fact.Signature is not null ? FactSignature : 0) | (fact.Stale ? FactStale : 0) | (fact.TextLeftOut ? FactTextLeftOut : 0)));
                if (fact.Rows is { } rows) writer.Int64(rows);
                if (fact.Bytes is { } bytes) writer.Int64(bytes);
                if (fact.Listed is { } listed) writer.Int64(listed);
                if (fact.Partitioning is { } partitioning) writer.Text(partitioning);
                if (fact.Clustering is { } clustering) writer.Text(clustering);
                if (fact.Signature is { } signature) writer.Text(signature);
            }
            writer.Int32(plan.Descriptions.Length);
            foreach (var (at, description) in plan.Descriptions)
            {
                writer.Int32(at);
                writer.Text(description);
            }
            writer.Int32(plan.Shards.Length);
            foreach (var (at, group) in plan.Shards)
            {
                writer.Int32(at);
                writer.Text(group.Prefix);
                writer.Int32(group.Count);
                writer.Text(group.First);
                writer.Text(group.Last);
            }
        }

        var texts = table.Texts;
        for (var id = 0; id < plan.Strings; id++)
        {
            if ((id & (Batch - 1)) == 0) token.ThrowIfCancellationRequested();
            writer.Byte(plan.Uses[id]);
            writer.Text((string)texts[plan.Order[id]]!);
        }
        // The long definitions are compressed already: their frames, and the few bytes before each, go in as they are.
        writer.AsIs(true);
        for (var id = plan.Strings; id < plan.Order.Length; id++)
        {
            token.ThrowIfCancellationRequested();
            var frame = (PackedText)texts[plan.Order[id]]!;
            writer.Byte(plan.Uses[id]);
            writer.Int32(frame.Length);
            writer.Int32(frame.ByteLength);
            writer.Int32(frame.FrameLength);
            writer.Bytes(frame.Frame);
            // A frame that packs better than the format's ratio is padded up to it, as a block is.
            for (var padding = IndexFileContainer.Padding((uint)frame.ByteLength, (uint)frame.FrameLength); padding > 0; padding -= Math.Min(padding, Batch))
                writer.Bytes(Zeros.AsSpan(0, Math.Min(padding, Batch)));
        }
        writer.AsIs(false);

        writer.Int32(extra.Length);
        writer.Bytes(extra);
        writer.Finish();
    }

    /// <summary>A date with its kind, which <see cref="DateTime"/>'s own binary form would turn to local time.</summary>
    private static long Pack(DateTime value) => value.Ticks | (long)value.Kind << 62;

    private static DateTime Unpack(long value)
    {
        var (ticks, kind) = (value & (1L << 62) - 1, (int)(value >>> 62));
        if (ticks > DateTime.MaxValue.Ticks || kind > (int)DateTimeKind.Local) throw Corrupt();
        return new DateTime(ticks, (DateTimeKind)kind);
    }

    // ---- Loading ----

    /// <summary>What a load takes of the index's memory, and how it holds a text.</summary>
    internal abstract class Account
    {
        /// <summary>Charges the text's place in the table and answers the copy of <paramref name="value"/> the load holds (a
        /// text that may be left out is taken first, with the room the place needs kept free): null when it does not fit (its
        /// place stays, empty).</summary>
        public abstract object? Text(object value, TextUse use);
        public abstract void Records(long own, long detailChildren);
        public abstract void Details(long bytes);
        public abstract void Fact(long bytes);
        public abstract void Description(long bytes);
        /// <summary>What the read charged beyond its content.</summary>
        public abstract void Rest(long bytes);
    }

    /// <summary>
    /// A read's load: texts are the <see cref="StringPool"/>'s, and every byte is charged as the reader that made the unit
    /// charges it (<see cref="DatabaseReader"/>, <see cref="BigQueryReader"/>): against the share of the read it replaces first,
    /// names whatever is free, definitions only above the names' reserve, and for BigQuery nothing below its floors
    /// (<see cref="ObjectIndexLimits.BigQueryNamesFloorBytes"/> for names, the details' floor for columns and text), with the
    /// replaced read's share in its two parts: its names' part pays for names and the rest for details.
    /// </summary>
    internal sealed class PooledAccount(ObjectIndexLimits limits, StringPool pool, DatabaseIndex? credit, bool bigQuery, long namesFloor, long detailsFloor) : Account
    {
        private readonly IndexBudget budget = pool.Budget;
        // SQL Server's reads use one share (what is left of it); BigQuery's is all of it, whatever kind each part paid for.
        private long creditLeft = credit?.Bytes ?? 0;
        private readonly long shareBytes = credit?.Bytes ?? 0;

        public long Taken { get; private set; }
        public long Credited { get; private set; }
        /// <summary>BigQuery: what the load charged as names (<see cref="DatabaseIndex.NameBytes"/>).</summary>
        public long NameBytes { get; private set; }
        public DatabaseIndex? Credit => credit;

        // BigQuery: what the load has charged of each kind, and how much of each the budget holds (the share holds the rest).
        private long namesCharged, detailsCharged, namesOnBudget, detailsOnBudget;
        // BigQuery: what the pool charged the budget for names the load took (texts it did not hold yet).
        private long namesPooled;

        /// <summary>Takes a text from the pool. A BigQuery replacement's detail is checked as its charges are: as if it came
        /// before the names the budget holds for this load.</summary>
        private object? Acquire(object value, long keepFree, bool name)
        {
            if (bigQuery && !name && shareBytes > 0) keepFree = Math.Max(namesFloor, keepFree - namesOnBudget - namesPooled);
            var acquired = pool.TryAcquire(value, keepFree, out var charged);
            if (bigQuery && name) namesPooled += charged;
            return acquired;
        }

        /// <summary>Charges <paramref name="bytes"/> of a name or a detail. SQL Server's: to what is left of the replaced read's
        /// share, the rest to the budget when that leaves <paramref name="keepFree"/> free, as <see cref="DatabaseReader"/> does.
        /// BigQuery's: the share pays for as much of everything charged so far as it covers, and the budget holds only the rest,
        /// names first, since theirs is the lower floor; the budget is checked as if its details had come before its names (the
        /// details above their floor, the names above theirs). A read charges entry by
        /// entry and splits the share between names and details, lending between the parts once the budget refuses; a load
        /// charges section by section, so it does not follow the read's order but holds the share whole: it is never refused
        /// where the read fits, and takes no more of the budget than the read.</summary>
        private bool TryCharge(long bytes, long keepFree, bool name)
        {
            if (bytes <= 0) return true;
            if (!bigQuery)
            {
                var fromShare = Math.Min(creditLeft, bytes);
                if (bytes > fromShare && !budget.TryTake(bytes - fromShare, keepFree)) return false;
                creditLeft -= fromShare;
                Credited += fromShare;
                Taken += bytes - fromShare;
                return true;
            }
            var (names, details) = name ? (namesCharged + bytes, detailsCharged) : (namesCharged, detailsCharged + bytes);
            var onBudget = Math.Max(0, names + details - shareBytes);
            var namesOn = Math.Min(names, onBudget);
            var detailsOn = onBudget - namesOn;
            var take = onBudget - Taken;
            // Checked as if the details on the budget had come before every name there (in a replacement, where the order
            // decides what the share pays for): details that grow it above their floor, with the names it holds for this load
            // counted as after them; names above theirs. A name never puts more details there.
            var keep = detailsOn > detailsOnBudget ? Math.Max(namesFloor, keepFree - (shareBytes > 0 ? namesOn + namesPooled : 0)) : name ? keepFree : namesFloor;
            if (take > 0 && !budget.TryTake(take, keep)) return false;
            (namesCharged, detailsCharged, namesOnBudget, detailsOnBudget) = (names, details, namesOn, detailsOn);
            Taken = onBudget;
            Credited = names + details - onBudget;
            return true;
        }

        /// <summary>A BigQuery name's share (a record, its facts, a text's slot): the names' part of the replaced read's share,
        /// else the budget above the names floor (<see cref="BigQueryReader"/>).</summary>
        private bool TryChargeName(long bytes)
        {
            if (!TryCharge(bytes, namesFloor, name: true)) return false;
            NameBytes += Math.Max(0, bytes);
            return true;
        }

        private bool Charge(long bytes, bool name) => !bigQuery ? TryCharge(bytes, 0, name: false) : name ? TryChargeName(bytes) : TryCharge(bytes, detailsFloor, name: false);

        public override object? Text(object value, TextUse use)
        {
            var needed = (use & (TextUse.Name | TextUse.ChildName)) != 0;
            // Charged as a name unless something else named it first. A string no entry names is the name of a row the read
            // then left out (a child whose parent the login cannot see): taken as a name is, though the load does without it
            // when it does not fit.
            var name = (use & (TextUse.Name | TextUse.DetailFirst)) == TextUse.Name || use == TextUse.None && value is string;
            // A definition gives way to names.
            var keepFree = !bigQuery ? needed || name ? 0 : limits.NamesReserveBytes : name ? namesFloor : needed ? detailsFloor : Math.Max(detailsFloor, limits.NamesReserveBytes);
            if (needed)
            {
                if (!Charge(IndexMemory.SlotBytes, name)) throw Budget();
                return Acquire(value, keepFree, name) ?? throw Budget();
            }
            // A text that may be left out is held, with its slot, while both fit where a read keeps them. Otherwise it is left
            // out, as a read leaves it; its place in the table stays, empty, since the entries name their texts by place, and
            // is charged as a name's is.
            var pooledBefore = namesPooled;
            var acquired = Acquire(value, keepFree, name);
            if (acquired is not null)
            {
                if (bigQuery && name ? TryChargeName(IndexMemory.SlotBytes) : TryCharge(IndexMemory.SlotBytes, keepFree, name: false)) return acquired;
                pool.Release([acquired]);
                namesPooled = pooledBefore;
            }
            if (!Charge(IndexMemory.SlotBytes, name: true)) throw Budget();
            return null;
        }

        public override void Records(long own, long detailChildren)
        {
            // Columns first: a read charges each object's columns right after its name, before the names of the objects listed
            // after it, so the columns have first claim on the room above the details' floor and on the names' part to borrow.
            if (!Charge(detailChildren * IndexMemory.RecordBytes, name: false) || !Charge(own * IndexMemory.RecordBytes, name: true)) throw Budget();
        }

        public override void Details(long bytes)
        {
            if (!Charge(bytes, name: false)) throw Budget();
        }

        public override void Fact(long bytes)
        {
            if (!Charge(bytes, name: true)) throw Budget();
        }

        public override void Description(long bytes)
        {
            if (!Charge(bytes, name: false)) throw Budget();
        }

        public override void Rest(long bytes)
        {
            if (!Charge(bytes, name: true)) throw Budget();
        }

        /// <summary>Gives back what a refused load took; the share it would have replaced stays with its owner.</summary>
        public void Abandon(IEnumerable<object?> held)
        {
            pool.Release(held);
            budget.Release(Taken);
            Taken = Credited = NameBytes = creditLeft = namesCharged = detailsCharged = namesOnBudget = detailsOnBudget = namesPooled = 0;
        }
    }

    /// <summary>The shared resource set's load: nothing is pooled or charged here, since <see cref="ResourceCatalog"/> does both
    /// when it shares the table, as it does a read's. What that will cost is kept within <paramref name="most"/>, as a budget
    /// would keep it: before anything is held.</summary>
    internal sealed class PlainAccount(long most) : Account
    {
        private long total;

        private void Add(long bytes)
        {
            total += bytes;
            if (total > most) throw Budget();
        }

        public override object? Text(object value, TextUse use)
        {
            Add(StringPool.Cost(value));
            return value;
        }

        public override void Records(long own, long detailChildren) => Add((own + detailChildren) * IndexMemory.RecordBytes);
        public override void Details(long bytes) => Add(bytes);
        public override void Fact(long bytes) => Add(bytes);
        public override void Description(long bytes) => Add(bytes);
        public override void Rest(long bytes) { }
    }

    /// <summary>Which of a file's entries a load without children keeps, and where: a bit for each, so the load never holds
    /// the entries it reads past. A second bit remembers which of those had a definition cut at its limit.</summary>
    private sealed class Places(int count)
    {
        private readonly ulong[] kept = new ulong[(count + 63) / 64];
        private readonly ulong[] cut = new ulong[(count + 63) / 64];
        private readonly int[] before = new int[(count + 63) / 64];

        public void Keep(int at) => kept[at >> 6] |= 1UL << (at & 63);
        public void Cut(int at) => cut[at >> 6] |= 1UL << (at & 63);
        public bool WasCut(int at) => (cut[at >> 6] & 1UL << (at & 63)) != 0;

        /// <summary>Counts the kept entries before each word of bits, once every entry is marked.</summary>
        public void Number()
        {
            for (int word = 0, total = 0; word < kept.Length; word++)
            {
                before[word] = total;
                total += BitOperations.PopCount(kept[word]);
            }
        }

        /// <summary>The kept entry's place among the kept, or -1 for one read past.</summary>
        public int Of(int at)
        {
            var (word, bit) = (kept[at >> 6], 1UL << (at & 63));
            return (word & bit) == 0 ? -1 : before[at >> 6] + BitOperations.PopCount(word & (bit - 1));
        }
    }

    /// <summary>What a load gathers one at a time (the texts it holds, the use each stated): kept in runs of a fixed size, so
    /// gathering never copies what is held, nor holds more room than a run beyond what was added.</summary>
    internal sealed class Segments<T> : IEnumerable<T>
    {
        private const int Run = 4096;
        private readonly List<T[]> runs = [];

        public int Count { get; private set; }
        public T this[int at] => runs[at / Run][at % Run];

        public void Add(T value)
        {
            if (Count % Run == 0) runs.Add(new T[Run]);
            runs[Count / Run][Count % Run] = value;
            Count++;
        }

        public T[] ToArray()
        {
            var all = new T[Count];
            for (var run = 0; run < runs.Count; run++) runs[run].AsSpan(0, Math.Min(Run, Count - run * Run)).CopyTo(all.AsSpan(run * Run));
            return all;
        }

        public IEnumerator<T> GetEnumerator()
        {
            for (var at = 0; at < Count; at++) yield return this[at];
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    /// <summary>
    /// Reads a unit's content, checking it as it goes and charging <paramref name="account"/> before it keeps anything.
    /// <paramref name="held"/> receives every text the account answered (a failed load gives those back). Without
    /// <paramref name="children"/> the columns, indexes, statistics and parameters, their names and the details are read past
    /// and not kept, as a read without children keeps none.
    /// </summary>
    public static LoadedUnit Load(Reader reader, IndexFileHeader header, Account account, bool children, Segments<object?> held, CancellationToken token)
    {
        var kind = header.Kind;
        var resource = kind == IndexUnitKind.Resource;
        if (header.Provider != ProviderOf(kind)) throw Corrupt();

        var unitFlags = reader.UInt16();
        if ((unitFlags & ~UnitFlags) != 0) throw Corrupt();
        bool Has(ushort flag) => (unitFlags & flag) != 0;
        var dataset = kind == IndexUnitKind.Dataset;
        if (Has(DatasetFlag) != dataset || Has(FactsFlag) != dataset || Has(DetailedFlag) && (!dataset || Has(ChildrenLeftOutFlag)) || Has(CaseSensitiveFlag) && !Has(CaseKnownFlag)
            || resource && (unitFlags & ~DefinitionsLeftOutFlag) != 0 || header.Definitions == Has(DefinitionsLeftOutFlag) || header.Children == Has(ChildrenLeftOutFlag)) throw Corrupt();
        var name = reader.Text(IndexFileLimits.NameChars);
        var datasetName = dataset ? reader.Text(IndexFileLimits.NameChars) : null;
        var (modules, cut, leftOut) = (reader.Int32(), reader.Int32(), reader.Int32());
        ResourceKey? key = null;
        if (resource)
        {
            var (edition, objectCount, hasLatest, latest, checksum) = (reader.Int32(), reader.Int64(), reader.Byte(), reader.Int64(), reader.Int32());
            if (hasLatest > 1 || hasLatest == 0 && latest != 0) throw Corrupt();
            key = new(name, edition, objectCount, hasLatest == 1 ? Unpack(latest) : null, checksum, !Has(DefinitionsLeftOutFlag));
        }

        var shapeCount = reader.Count(IndexFileLimits.Shapes);
        var shapeList = new ObjectShapes.Shape[shapeCount];
        var detailShape = new bool[shapeCount];
        for (var id = 0; id < shapeCount; id++)
        {
            var shapeKind = reader.Text(IndexFileLimits.ShapeChars);
            var folder = reader.Text(IndexFileLimits.ShapeChars);
            var subtype = reader.Byte() switch { 0 => null, 1 => reader.Text(IndexFileLimits.ShapeChars), _ => throw Corrupt() };
            shapeList[id] = Shape(shapeKind, folder, subtype);
            detailShape[id] = DetailChild(shapeKind);
        }

        // The texts, by number alone: the strings a read without children keeps, all the strings, the long definitions it
        // keeps, all the texts. A text's id says its form and whether this load keeps it; nothing is held for them yet.
        var (ownStrings, strings, ownLong, textCount) = (reader.Count(IndexFileLimits.Texts), reader.Count(IndexFileLimits.Texts), reader.Count(IndexFileLimits.Texts), reader.Count(IndexFileLimits.Texts));
        if (ownStrings > strings || (long)strings + ownLong > textCount) throw Corrupt();
        // A string is its use, its length and its text; a long definition its use, three lengths and its frame.
        reader.Backed(strings * 5L + (textCount - strings) * 14L);
        var forms = children ? new FileForms(strings, textCount) : new FileForms(ownStrings, ownStrings + ownLong);
        // A file's text id as this load holds it: itself, or without children its place among the texts kept.
        int Text(int id) => children || id < ownStrings ? id : id >= strings && id - strings < ownLong ? ownStrings + (id - strings) : int.MinValue;

        // Entries. The file states how many are detail children, so the entries this load keeps are charged before there is
        // anywhere to put them; their flags and shapes, which come first, then say which they are. Without children the
        // others are read past: places says which of the file's entries are kept, and where.
        var count = reader.Count(resource ? IndexFileLimits.ResourceObjects : IndexFileLimits.Objects);
        var detailEntries = reader.Count(count, IndexFileProblem.Corrupt);
        if (count != header.Objects || Has(ChildrenLeftOutFlag) && detailEntries != 0) throw Corrupt();
        CheckCounts(modules, cut, leftOut, count);
        // An entry is 23 bytes of the content to come.
        reader.Backed(count * 23L);
        var ownEntries = count - detailEntries;
        account.Records(ownEntries, children ? detailEntries : 0);
        var entries = new ObjectEntry[children ? count : ownEntries];
        var places = children ? null : new Places(count);
        var triples = new byte[3 * Batch];
        var (kept, details) = (0, 0);
        for (var from = 0; from < count; from += Batch)
        {
            var run = triples.AsSpan(0, 3 * Math.Min(Batch, count - from));
            reader.Bytes(run);
            for (var at = 0; at < run.Length / 3; at++)
            {
                var (entryFlags, shape) = (run[3 * at], BinaryPrimitives.ReadUInt16LittleEndian(run[(3 * at + 1)..]));
                if (shape >= shapeCount) throw Corrupt();
                var detail = (entryFlags & ObjectTable.ChildFlag) != 0 && detailShape[shape];
                if (detail) details++;
                if (places is null) (entries[from + at].Flags, entries[from + at].Shape) = (entryFlags, shape);
                else if (detail)
                {
                    if ((entryFlags & ObjectTable.CutFlag) != 0) places.Cut(from + at);
                }
                else
                {
                    // More entries to keep than the file stated, and the load charged.
                    if (kept == entries.Length) throw Corrupt();
                    (entries[kept].Flags, entries[kept].Shape) = (entryFlags, shape);
                    places.Keep(from + at);
                    kept++;
                }
            }
        }
        if (details != detailEntries) throw Corrupt();
        places?.Number();
        int Moved(int at) => places is null ? at : places.Of(at);
        var values = new int[Batch];
        var elsewhere = 0;
        for (var column = 0; column < 5; column++)
            for (var from = 0; from < count; from += Batch)
            {
                token.ThrowIfCancellationRequested();
                var run = values.AsSpan(0, Math.Min(Batch, count - from));
                reader.Int32s(run);
                for (var at = 0; at < run.Length; at++)
                {
                    var value = run[at];
                    var to = Moved(from + at);
                    if (to < 0)
                    {
                        // A column's expression goes with the column: no longer a module, nor cut. Its date, if it has one
                        // elsewhere, goes too.
                        if (column == 3 && value >= 0) modules--;
                        if (column == 3 && places!.WasCut(from + at)) cut--;
                        if (column == 4 && unchecked((uint)value) == uint.MaxValue) elsewhere++;
                        continue;
                    }
                    ref var entry = ref entries[to];
                    switch (column)
                    {
                        case 0: entry.Name = Text(value); break;
                        case 1: entry.Schema = value == -1 ? -1 : Text(value); break;
                        case 2:
                            // An owner is named by its place in the file: kept, it is named by its place among the kept.
                            if (places is not null && value != -1 && ((uint)value >= (uint)count || (value = places.Of(value)) < 0)) throw Corrupt();
                            entry.Owner = value;
                            break;
                        case 3: entry.Definition = value == -1 ? -1 : Text(value); break;
                        default: entry.Modified = unchecked((uint)value); break;
                    }
                }
            }
        CheckEntries(entries, forms, shapeCount, detailShape, dataset, !Has(DefinitionsLeftOutFlag));

        // Dates: one for each entry whose 32 bits say "elsewhere", in entry order.
        var keptElsewhere = 0;
        foreach (ref readonly var entry in entries.AsSpan())
            if (entry.Modified == uint.MaxValue) keptElsewhere++;
        var dateCount = reader.Count(IndexFileLimits.Dates);
        if (dateCount != keptElsewhere + elsewhere) throw Corrupt();
        Dictionary<int, DateTime>? dates = keptElsewhere == 0 ? null : new(keptElsewhere);
        for (int item = 0, last = -1; item < dateCount; item++)
        {
            var (at, date) = (reader.Int32(), Unpack(reader.Int64()));
            if (at <= last || at >= count) throw Corrupt();
            last = at;
            if (Moved(at) < 0) continue;
            if (entries[Moved(at)].Modified != uint.MaxValue) throw Corrupt();
            dates![Moved(at)] = date;
        }
        if ((dates?.Count ?? 0) != keptElsewhere) throw Corrupt();

        // Details: charged, then read, then checked. A load without children reads past them.
        var (typeCount, typedCount, keyCount, keyColumnCount) = (reader.Count(IndexFileLimits.Types), reader.Count(IndexFileLimits.Objects),
            reader.Count(IndexFileLimits.Objects), reader.Count(IndexFileLimits.KeyColumns));
        var detailBytes = typeCount * IndexMemory.TypeBytes + typedCount * IndexMemory.TypedBytes + keyCount * IndexMemory.KeyBytes + keyColumnCount * IndexMemory.KeyColumnBytes;
        ObjectDetails.Parts? parts = null;
        // On disk a type is 14 bytes, a typed entry 13, a key 14 and a key column 5 (the arrays read below).
        var detailContent = typeCount * 14L + typedCount * 13L + keyCount * 14L + keyColumnCount * 5L;
        if (Has(ChildrenLeftOutFlag) && detailContent != 0) throw Corrupt();
        reader.Backed(detailContent);
        if (!children) reader.Skip(detailContent);
        else if (detailBytes > 0)
        {
            account.Details(detailBytes);
            parts = new(new int[typeCount], new int[typeCount], new int[typeCount], new byte[typeCount], new byte[typeCount], new int[typedCount], new ushort[typedCount],
                new short[typedCount], new byte[typedCount], new byte[typedCount], new short[typedCount], new byte[typedCount], new int[keyCount], new int[keyCount],
                new short[keyCount], new int[keyCount], new short[keyColumnCount], new short[keyColumnCount], new byte[keyColumnCount]);
            reader.Int32s(parts.TypeName);
            reader.Int32s(parts.TypeSchema);
            reader.Int32s(parts.TypeId);
            reader.Bytes(parts.TypeSystem);
            reader.Bytes(parts.TypeFlags);
            reader.Int32s(parts.TypedAt);
            reader.UInt16s(parts.TypedType);
            reader.Int16s(parts.TypedLength);
            reader.Bytes(parts.TypedPrecision);
            reader.Bytes(parts.TypedScale);
            reader.Int16s(parts.TypedOrdinal);
            reader.Bytes(parts.TypedFlags);
            reader.Int32s(parts.KeyAt);
            reader.Int32s(parts.KeyFrom);
            reader.Int16s(parts.KeyCount);
            reader.Int32s(parts.KeyReferenced);
            reader.Int16s(parts.KeyColumn);
            reader.Int16s(parts.KeyOther);
            reader.Bytes(parts.KeyColumnFlags);
            CheckDetails(parts, entries, forms);
        }
        token.ThrowIfCancellationRequested();

        // What the content holds whole, for the charge the file states.
        var whole = count * IndexMemory.RecordBytes + detailBytes + textCount * IndexMemory.SlotBytes;

        Dictionary<int, BigQueryObjectFacts>? objects = null;
        Dictionary<int, string>? descriptions = null;
        Dictionary<int, Varia.Backend.BigQueryShardsDto>? shards = null;
        if (dataset)
        {
            var factCount = reader.Count(count, IndexFileProblem.Corrupt);
            objects = [];
            for (int item = 0, last = -1; item < factCount; item++)
            {
                if ((item & (Batch - 1)) == 0) token.ThrowIfCancellationRequested();
                var (at, created, factFlags) = (reader.Int32(), reader.Int64(), reader.UInt16());
                if (at <= last || at >= count || (factFlags & ~FactFlags) != 0) throw Corrupt();
                last = at;
                bool Stated(ushort flag) => (factFlags & flag) != 0;
                long? rows = Stated(FactRows) ? reader.Int64() : null;
                long? size = Stated(FactBytes) ? reader.Int64() : null;
                long? listed = Stated(FactListed) ? reader.Int64() : null;
                var partitioning = Stated(FactPartitioning) ? reader.Text(IndexFileLimits.FactChars) : null;
                var clustering = Stated(FactClustering) ? reader.Text(IndexFileLimits.FactChars) : null;
                var signature = Stated(FactSignature) ? reader.Text(IndexFileLimits.FactChars) : null;
                var fact = new BigQueryObjectFacts(created, Stated(FactDetailed), rows, size, partitioning, clustering, signature, Stated(FactWhole), Stated(FactColumnsCut), listed, Stated(FactStale), Stated(FactTextLeftOut));
                if (!FactFits(fact, Has(DefinitionsLeftOutFlag))) throw Corrupt();
                // Facts are an object's, never a column's, so a load without children keeps them all.
                if (Moved(at) < 0 || (entries[Moved(at)].Flags & ObjectTable.ChildFlag) != 0) throw Corrupt();
                var cost = FactBytesOf(fact);
                whole += cost;
                // The object's facts are its name's; what pass 2 read of it (signature, layout) is a detail, as the read charges.
                account.Fact(BigQueryFacts.ObjectBytes);
                account.Details(cost - BigQueryFacts.ObjectBytes);
                objects[Moved(at)] = fact;
            }
            var descriptionCount = reader.Count(count, IndexFileProblem.Corrupt);
            if (Has(ChildrenLeftOutFlag) && descriptionCount != 0) throw Corrupt();
            descriptions = [];
            for (int item = 0, last = -1; item < descriptionCount; item++)
            {
                if ((item & (Batch - 1)) == 0) token.ThrowIfCancellationRequested();
                var at = reader.Int32();
                if (at <= last || at >= count) throw Corrupt();
                last = at;
                var description = reader.Text(IndexFileLimits.FactChars);
                // A description is a column's: it goes with the columns.
                if (places is not null ? places.Of(at) >= 0 : (entries[at].Flags & ObjectTable.ChildFlag) == 0 || !detailShape[entries[at].Shape]) throw Corrupt();
                whole += DescriptionBytesOf(description);
                if (!children) continue;
                account.Description(DescriptionBytesOf(description));
                descriptions[at] = description;
            }
            var shardCount = reader.Count(count, IndexFileProblem.Corrupt);
            shards = [];
            for (int item = 0, last = -1; item < shardCount; item++)
            {
                var at = reader.Int32();
                if (at <= last || at >= count) throw Corrupt();
                last = at;
                var prefix = reader.Text(IndexFileLimits.FactChars);
                var shardTotal = reader.Int32();
                var group = new Varia.Backend.BigQueryShardsDto(prefix, shardTotal, reader.Text(IndexFileLimits.FactChars), reader.Text(IndexFileLimits.FactChars));
                if (shardTotal < 0 || Moved(at) < 0 || (entries[Moved(at)].Flags & ObjectTable.ChildFlag) != 0) throw Corrupt();
                var cost = ShardBytesOf(group);
                whole += cost;
                account.Fact(cost);
                shards[Moved(at)] = group;
            }
        }

        // Texts, last, one at a time: each is charged its place in the table before it has one, so the table's texts are
        // never more than the load has paid for. Names come first (the strings), then long definitions. The use each states
        // says how it is charged; it is checked against the entries once all are read. Without children, only the uses a load
        // without children can tell from its entries count, and the texts it does not keep are read past.
        var compared = children ? Uses5 : OwnUses;
        var stated = new Segments<byte>();
        var leftOutTexts = false;
        void Hold(object value, byte use)
        {
            var copy = account.Text(value, (TextUse)(use & compared));
            leftOutTexts |= copy is null;
            held.Add(copy);
            stated.Add(use);
        }
        for (var id = 0; id < strings; id++)
        {
            if ((id & (Batch - 1)) == 0) token.ThrowIfCancellationRequested();
            var use = reader.Byte();
            if (!UseFits(use, longDefinition: false, own: id < ownStrings, dataset)) throw Corrupt();
            var chars = reader.Count(IsName(use) ? IndexFileLimits.NameTextChars : IndexFileLimits.TextChars);
            if (children || id < ownStrings) Hold(reader.Chars(chars), use);
            else reader.Skip(2L * chars);
        }
        var scratch = new PackedText.Scratch();
        reader.Plain(true);
        for (var id = strings; id < textCount; id++)
        {
            token.ThrowIfCancellationRequested();
            var (use, length, byteLength, frameLength) = (reader.Byte(), reader.Int32(), reader.Int32(), reader.Int32());
            if (!UseFits(use, longDefinition: true, own: id - strings < ownLong, dataset)) throw Corrupt();
            if (length <= 0 || length > IndexFileLimits.TextChars || byteLength < length || byteLength > 3L * length || frameLength <= 0 || frameLength > PackedText.MaxFrameLength(byteLength)) throw Corrupt();
            // The padding that keeps what a frame unpacks to within the format's ratio of what it takes in the file.
            var padding = IndexFileContainer.Padding((uint)byteLength, (uint)frameLength);
            if (!children && id - strings >= ownLong)
            {
                reader.Skip((long)frameLength + padding);
                continue;
            }
            reader.Backed((long)frameLength + padding);
            var frame = new byte[frameLength];
            reader.Bytes(frame);
            reader.Skip(padding);
            Hold(PackedText.FromFrame(frame, length, byteLength, scratch) ?? throw Corrupt(), use);
        }
        reader.Plain(false);

        // The uses the file stated decided how each text was charged, so they must be the entries' own.
        var uses = Uses(entries, detailShape, parts, held.Count);
        for (var id = 0; id < uses.Length; id++)
            if ((stated[id] & compared) != (uses[id] & compared)) throw Corrupt();
        // Without children the uses a column would add are not known, so a name's length is checked where it is named.
        for (var at = 0; !children && at < entries.Length; at++)
            if (((string)held[entries[at].Name]!).Length > IndexFileLimits.NameTextChars || entries[at].Schema >= 0 && ((string)held[entries[at].Schema]!).Length > IndexFileLimits.NameTextChars)
                throw IndexFileContainer.Refused(IndexFileProblem.Limits);

        // An entry whose definition was left out for memory loses it, as a read that could not keep a definition counts it:
        // cut, and left out for memory. (A name is never left out: the load is refused instead.)
        for (var at = 0; leftOutTexts && at < entries.Length; at++)
        {
            ref var entry = ref entries[at];
            if (entry.Definition < 0 || held[entry.Definition] is not null) continue;
            if ((entry.Flags & ObjectTable.CutFlag) == 0) cut++;
            entry.Flags &= unchecked((byte)~ObjectTable.CutFlag);
            entry.Definition = -1;
            modules--;
            leftOut++;
            // An object whose text the load left out is not whole: the next build reads it again (BigQueryReader).
            if (objects is not null && objects.TryGetValue(at, out var fact)) objects[at] = fact with { Whole = false, TextLeftOut = fact.Detailed };
        }
        (modules, cut) = (Math.Max(0, modules), Math.Max(0, cut));
        // Without children the counts were checked against the entries the file has, not the ones the load keeps: hold them
        // to those, so a unit that keeps few entries never reports more than they could account for.
        if (!children) (modules, cut) = (Math.Min(modules, CountsFor(entries.Length)), Math.Min(cut, CountsFor(entries.Length)));
        leftOut = Math.Min(leftOut, cut);

        var extraBytes = reader.Count(IndexFileLimits.ExtraBytes);
        reader.Backed(extraBytes);
        var extra = new byte[extraBytes];
        reader.Bytes(extra);
        reader.End();

        // The charge the file states is the read's: its content, and what the read charged for rows it then left out. The
        // shared set's is its records and details, which the catalog works out again.
        var charge = header.MemoryBytes;
        if (resource ? charge != count * IndexMemory.RecordBytes + detailBytes : charge < whole || charge - whole > whole + ChargeSlack) throw Corrupt();
        if (children && !resource) account.Rest(charge - whole);

        var table = ObjectTable.FromParts(entries, held.ToArray(), shapeList, dates, parts is null ? null : ObjectDetails.FromParts(parts));
        return new(name, datasetName, table, dataset ? new BigQueryFacts(objects!, descriptions!, shards!) : null, modules, cut, leftOut, Has(ChildrenLeftOutFlag) || !children,
            Has(DefinitionsLeftOutFlag), Has(DetailedFlag) && children, Has(FailedPartFlag), Has(CaseKnownFlag) ? Has(CaseSensitiveFlag) : null, Has(DottedIFlag), key, extra);
    }
}
