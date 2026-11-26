using System.Collections.Concurrent;
using Reader = Varia.Backend.Search.IndexFileContainer.PayloadReader;
using Writer = Varia.Backend.Search.IndexFileContainer.PayloadWriter;

namespace Varia.Backend.Search;

/// <summary>How a table's entries name one of its texts. A load charges a text by it as the read that made the table did (a
/// name must fit, a definition may be left out), and a load without children keeps only the first and third.</summary>
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
    ChildDefinition = 8
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
/// its entries name (by value: <see cref="ObjectShapes"/> ids are a process's own), its texts, its entries column by column, its
/// out-of-range dates, its <see cref="ObjectDetails"/>, BigQuery's facts, and the caller's opaque bytes. Lookup arrays are not
/// saved; a load builds none.
/// <code>
/// unit:     u16 flags | text name | (text dataset) | i32 modules, cut, left out |
///           (resource: i32 edition | i64 count | u8 has latest | i64 latest | i32 checksum)
/// shapes:   i32 n, each text kind | text folder | u8 has subtype | (text subtype)
/// tags:     i32 texts | u8 tag[texts] (form: 0 none, 1 string, 2 packed; then its TextUse)
/// entries:  i32 n | i32 how many are detail children | u8 flags[n] | u16 shape[n] | i32 name[n] | schema[n] | owner[n] |
///           definition[n] | u32 modified[n]
/// dates:    i32 n, each i32 entry | i64 ticks and kind
/// details:  i32 types, typed, keys, key columns | ObjectDetails' arrays in its order
/// facts:    (BigQuery) i32 n, each i32 entry | i64 created | u16 flags | its optional values; then descriptions and shard groups
/// texts:    each string in id order: i32 chars, UTF-16 | i32 packed | i32 chars[], bytes[], frame bytes[] | the frames, stored
/// extra:    i32 n | bytes
/// </code>
/// The texts come last, strings before long definitions, so a load has charged everything that must fit (entries, details,
/// facts, then names) before the first definition, which may be left out, asks for room. The entries state how many of them a
/// read without children leaves out (<see cref="DetailChild"/>), and their flags and shapes come first, so a load charges the
/// entries it keeps before it has anywhere to put them, and a load without children never holds the ones it does not keep.
/// A file is untrusted, and in clear text nothing below vouches for it, so <see cref="Load"/> checks everything a search or a
/// lookup relies on (<see cref="CheckEntries"/>, <see cref="CheckDetails"/>) before a table exists, and <see cref="Write"/>
/// refuses a unit those checks would refuse, so no file is written that cannot be loaded.
/// </summary>
internal static class IndexFileUnit
{
    private const ushort ChildrenLeftOutFlag = 1, DefinitionsLeftOutFlag = 2, DetailedFlag = 4, FailedPartFlag = 8, CaseKnownFlag = 16, CaseSensitiveFlag = 32, DottedIFlag = 64,
        FactsFlag = 128, DatasetFlag = 256, UnitFlags = 511;
    private const byte NoText = 0, StringText = 1, PackedForm = 2;
    private const ushort FactDetailed = 1, FactWhole = 2, FactColumnsCut = 4, FactRows = 8, FactBytes = 16, FactListed = 32, FactPartitioning = 64, FactClustering = 128,
        FactSignature = 256, FactFlags = 511;
    private const byte EntryFlags = ObjectTable.SystemFlag | ObjectTable.CutFlag | ObjectTable.ChildFlag;
    /// <summary>What a read's charge may exceed its content's by: rows it charged and then left out (a child whose parent the
    /// login cannot see). Past as much again as the content, and this, a file's stated charge is not believed.</summary>
    private const long ChargeSlack = 64 * 1024;
    private const int Batch = 4096;

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

    /// <summary>Every entry's references are in range and of the right form (<paramref name="tags"/>, by text): a name and a
    /// schema are strings, a definition any text held; only a definition is cut; a child's parent is not a child; and the table a
    /// history table is shown below is itself shown below none, so no walk from an entry to its owner goes further than two steps.</summary>
    public static void CheckEntries(ReadOnlySpan<ObjectEntry> entries, ReadOnlySpan<byte> tags, int shapeCount)
    {
        var texts = tags.Length;
        for (var at = 0; at < entries.Length; at++)
        {
            ref readonly var entry = ref entries[at];
            if ((entry.Flags & ~EntryFlags) != 0 || entry.Shape >= shapeCount) throw Corrupt();
            if ((uint)entry.Name >= (uint)texts || (tags[entry.Name] & 3) != StringText) throw Corrupt();
            if (entry.Schema != -1 && ((uint)entry.Schema >= (uint)texts || (tags[entry.Schema] & 3) != StringText)) throw Corrupt();
            if (entry.Definition != -1 && ((uint)entry.Definition >= (uint)texts || (tags[entry.Definition] & 3) == NoText)) throw Corrupt();
            if ((entry.Flags & ObjectTable.CutFlag) != 0 && entry.Definition < 0) throw Corrupt();
            var child = (entry.Flags & ObjectTable.ChildFlag) != 0;
            if (entry.Owner == -1)
            {
                if (child) throw Corrupt();
                continue;
            }
            if ((uint)entry.Owner >= (uint)entries.Length || entry.Owner == at) throw Corrupt();
            ref readonly var owner = ref entries[entry.Owner];
            if ((owner.Flags & ObjectTable.ChildFlag) != 0 || !child && owner.Owner != -1) throw Corrupt();
        }
    }

    /// <summary>The side dates are exactly those of the entries whose 32 bits say "elsewhere", in entry order.</summary>
    private static void CheckDates(ReadOnlySpan<ObjectEntry> entries, int dates)
    {
        var elsewhere = 0;
        foreach (ref readonly var entry in entries)
            if (entry.Modified == uint.MaxValue) elsewhere++;
        if (elsewhere != dates) throw Corrupt();
    }

    /// <summary>The details index only what the table holds, in the order <see cref="ObjectDetails"/> searches: a type's name
    /// and schema are strings, a typed entry's type exists, entries are sorted, a key's columns lie within the column list, and a
    /// key that names a table is a child (its own table is its parent).</summary>
    public static void CheckDetails(ObjectDetails.Parts parts, ReadOnlySpan<ObjectEntry> entries, ReadOnlySpan<byte> tags)
    {
        var texts = tags.Length;
        var types = parts.TypeName.Length;
        if (types > IndexFileLimits.Types || parts.KeyColumn.Length > IndexFileLimits.KeyColumns || parts.TypedAt.Length > IndexFileLimits.Objects
            || parts.KeyAt.Length > IndexFileLimits.Objects) throw IndexFileContainer.Refused(IndexFileProblem.Limits);
        for (var type = 0; type < types; type++)
        {
            var (name, schema) = (parts.TypeName[type], parts.TypeSchema[type]);
            if ((uint)name >= (uint)texts || (tags[name] & 3) != StringText) throw Corrupt();
            if (schema != -1 && ((uint)schema >= (uint)texts || (tags[schema] & 3) != StringText)) throw Corrupt();
            if ((parts.TypeFlags[type] & ~ObjectDetails.TypeFlagsMask) != 0) throw Corrupt();
        }
        var last = -1;
        for (var item = 0; item < parts.TypedAt.Length; item++)
        {
            var at = parts.TypedAt[item];
            if (at < last || (uint)at >= (uint)entries.Length || parts.TypedType[item] >= types) throw Corrupt();
            last = at;
        }
        last = -1;
        for (var item = 0; item < parts.KeyAt.Length; item++)
        {
            var at = parts.KeyAt[item];
            if (at < last || (uint)at >= (uint)entries.Length) throw Corrupt();
            last = at;
            var (from, count, referenced) = (parts.KeyFrom[item], parts.KeyCount[item], parts.KeyReferenced[item]);
            if (from < 0 || count < 0 || (long)from + count > parts.KeyColumn.Length) throw Corrupt();
            if (referenced == -1) continue;
            if ((uint)referenced >= (uint)entries.Length || (entries[at].Flags & ObjectTable.ChildFlag) == 0) throw Corrupt();
        }
    }

    /// <summary>Each text's use, from the entries and the details that name it (which <see cref="CheckEntries"/> and
    /// <see cref="CheckDetails"/> have passed).</summary>
    private static byte[] Uses(ReadOnlySpan<ObjectEntry> entries, bool[] detailShape, ObjectDetails.Parts? details, int texts)
    {
        var uses = new byte[texts];
        foreach (ref readonly var entry in entries)
        {
            var detail = (entry.Flags & ObjectTable.ChildFlag) != 0 && detailShape[entry.Shape];
            var name = (byte)(detail ? TextUse.ChildName : TextUse.Name);
            uses[entry.Name] |= name;
            if (entry.Schema >= 0) uses[entry.Schema] |= name;
            if (entry.Definition >= 0) uses[entry.Definition] |= (byte)(detail ? TextUse.ChildDefinition : TextUse.Definition);
        }
        if (details is not null)
            for (var type = 0; type < details.TypeName.Length; type++)
            {
                uses[details.TypeName[type]] |= (byte)TextUse.ChildName;
                if (details.TypeSchema[type] >= 0) uses[details.TypeSchema[type]] |= (byte)TextUse.ChildName;
            }
        return uses;
    }

    private static long FactBytesOf(in BigQueryObjectFacts fact) => BigQueryFacts.ObjectBytes + StringBytes(fact.Signature) + StringBytes(fact.Partitioning) + StringBytes(fact.Clustering);
    private static long ShardBytesOf(Varia.Backend.BigQueryShardsDto group) => BigQueryFacts.ShardBytes + StringBytes(group.Prefix) + StringBytes(group.First) + StringBytes(group.Last);
    private static long DescriptionBytesOf(string description) => BigQueryFacts.DescriptionBytes + IndexMemory.StringBytes(description.Length);
    private static long StringBytes(string? value) => value is null ? 0 : IndexMemory.StringBytes(value.Length);

    // ---- Writing ----

    /// <summary>What the unit's table and facts need of the format, worked out once before anything is written.</summary>
    internal sealed record Plan(byte[] Tags, ObjectShapes.Shape[] Shapes, ushort[] ShapeIds, int DetailEntries, ObjectDetails.Parts? Details, KeyValuePair<int, DateTime>[] Dates,
        KeyValuePair<int, BigQueryObjectFacts>[] Facts, KeyValuePair<int, string>[] Descriptions, KeyValuePair<int, Varia.Backend.BigQueryShardsDto>[] Shards);

    /// <summary>Checks <paramref name="unit"/> against the format's limits and rules: refused as Limits or Unsupported, so that
    /// whatever is written loads.</summary>
    public static Plan Prepare(IndexUnit unit, int extraBytes)
    {
        static IndexFileRefused Limits() => IndexFileContainer.Refused(IndexFileProblem.Limits);
        var table = unit.Table;
        var entries = table.Entries;
        var texts = table.Texts;
        var resource = unit.Kind == IndexUnitKind.Resource;
        if (entries.Length > (resource ? IndexFileLimits.ResourceObjects : IndexFileLimits.Objects) || texts.Count > IndexFileLimits.Texts || extraBytes > IndexFileLimits.ExtraBytes
            || unit.Name.Length > IndexFileLimits.NameChars || unit.Dataset is { Length: > IndexFileLimits.NameChars }) throw Limits();
        try
        {
            if (resource != unit.Resource is not null || unit.Kind == IndexUnitKind.Dataset != (unit.Dataset is not null) || unit.Kind == IndexUnitKind.Dataset != (unit.Facts is not null)
                || unit.Modules < 0 || unit.Cut < 0 || unit.LeftOut < 0 || unit.LeftOut > unit.Cut || unit.Bytes < 0 || unit.ReadAt.Kind != DateTimeKind.Utc) throw Corrupt();
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
            var tags = new byte[texts.Count];
            for (var id = 0; id < tags.Length; id++)
            {
                var text = texts[id];
                if (text is not null && DefinitionText.Length(text) > IndexFileLimits.TextChars) throw Limits();
                tags[id] = text switch { null => NoText, string => StringText, _ => PackedForm };
            }
            CheckEntries(entries, tags, all.Count);
            var details = table.Details?.ToParts();
            if (details is not null) CheckDetails(details, entries, tags);
            var detailShape = new bool[all.Count];
            for (var id = 0; id < detailShape.Length; id++) detailShape[id] = DetailChild(all[id].Kind);
            var uses = Uses(entries, detailShape, details, tags.Length);
            for (var id = 0; id < tags.Length; id++)
            {
                // A long definition is never a name, and a text given back names nothing.
                if (tags[id] == PackedForm && (uses[id] & (byte)(TextUse.Name | TextUse.ChildName)) != 0 || tags[id] == NoText && uses[id] != 0) throw Corrupt();
                tags[id] |= (byte)(uses[id] << 2);
            }
            var dates = (table.Dates ?? new Dictionary<int, DateTime>()).OrderBy(pair => pair.Key).ToArray();
            CheckDates(entries, dates.Length);
            foreach (var (at, _) in dates)
                if ((uint)at >= (uint)entries.Length || entries[at].Modified != uint.MaxValue) throw Corrupt();
            var facts = unit.Facts?.Objects.OrderBy(pair => pair.Key).ToArray() ?? [];
            var descriptions = unit.Facts?.Descriptions.OrderBy(pair => pair.Key).ToArray() ?? [];
            var shards = unit.Facts?.ShardGroups.OrderBy(pair => pair.Key).ToArray() ?? [];
            static bool Long(string? value) => value is { Length: > IndexFileLimits.FactChars };
            foreach (var (at, fact) in facts)
            {
                if ((uint)at >= (uint)entries.Length || (entries[at].Flags & ObjectTable.ChildFlag) != 0) throw Corrupt();
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
            var detailEntries = 0;
            foreach (ref readonly var entry in entries)
                if ((entry.Flags & ObjectTable.ChildFlag) != 0 && detailShape[entry.Shape]) detailEntries++;
            return new(tags, [.. used], ids, detailEntries, details, dates, facts, descriptions, shards);
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

        var texts = table.Texts;
        writer.Int32(texts.Count);
        writer.Bytes(plan.Tags);

        writer.Int32(entries.Length);
        writer.Int32(plan.DetailEntries);
        var flags = new byte[Batch];
        for (var from = 0; from < entries.Length; from += Batch)
        {
            var run = entries.Slice(from, Math.Min(Batch, entries.Length - from));
            for (var at = 0; at < run.Length; at++) flags[at] = run[at].Flags;
            writer.Bytes(flags.AsSpan(0, run.Length));
        }
        var shapeIds = new ushort[Batch];
        for (var from = 0; from < entries.Length; from += Batch)
        {
            var run = entries.Slice(from, Math.Min(Batch, entries.Length - from));
            for (var at = 0; at < run.Length; at++) shapeIds[at] = plan.ShapeIds[run[at].Shape];
            writer.UInt16s(shapeIds.AsSpan(0, run.Length));
        }
        var values = new int[Batch];
        for (var column = 0; column < 5; column++)
            for (var from = 0; from < entries.Length; from += Batch)
            {
                var run = entries.Slice(from, Math.Min(Batch, entries.Length - from));
                for (var at = 0; at < run.Length; at++)
                    values[at] = column switch { 0 => run[at].Name, 1 => run[at].Schema, 2 => run[at].Owner, 3 => run[at].Definition, _ => unchecked((int)run[at].Modified) };
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
            writer.Int32s(details.TypeName);
            writer.Int32s(details.TypeSchema);
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
                    | (fact.Clustering is not null ? FactClustering : 0) | (fact.Signature is not null ? FactSignature : 0)));
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

        var packed = new List<PackedText>();
        for (var id = 0; id < texts.Count; id++)
        {
            if ((id & (Batch - 1)) == 0) token.ThrowIfCancellationRequested();
            if (texts[id] is string text) writer.Text(text);
            else if (texts[id] is PackedText frame) packed.Add(frame);
        }
        writer.Int32(packed.Count);
        foreach (var frame in packed) writer.Int32(frame.Length);
        foreach (var frame in packed) writer.Int32(frame.ByteLength);
        foreach (var frame in packed) writer.Int32(frame.FrameLength);
        foreach (var frame in packed)
        {
            token.ThrowIfCancellationRequested();
            writer.Stored(frame.Frame);
        }

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
        /// <summary>Refuses a size the load could not be charged now, before anything is allocated by it.</summary>
        public abstract void Sane(long bytes);
        /// <summary>The copy of <paramref name="value"/> the load holds; null when a text that may be left out does not fit.</summary>
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
    /// (<see cref="ObjectIndexLimits.BigQueryNamesFloorBytes"/> for names, the details' floor for columns and text).
    /// </summary>
    internal sealed class PooledAccount(ObjectIndexLimits limits, StringPool pool, DatabaseIndex? credit, bool bigQuery, long namesFloor, long detailsFloor) : Account
    {
        private readonly IndexBudget budget = pool.Budget;
        private long creditLeft = credit?.Bytes ?? 0;

        public long Taken { get; private set; }
        public long Credited { get; private set; }
        public DatabaseIndex? Credit => credit;

        /// <summary>Charges to the credit first, the rest to the budget when that leaves <paramref name="keepFree"/> free.</summary>
        private bool TryCharge(long bytes, long keepFree)
        {
            if (bytes <= 0) return true;
            var fromCredit = Math.Min(creditLeft, bytes);
            if (bytes > fromCredit && !budget.TryTake(bytes - fromCredit, keepFree)) return false;
            creditLeft -= fromCredit;
            Credited += fromCredit;
            Taken += bytes - fromCredit;
            return true;
        }

        /// <summary>A BigQuery name's share: the budget above the names floor while it has the room, else the credit, which is
        /// kept for the details the earlier read held (<see cref="BigQueryReader"/>).</summary>
        private bool TryChargeName(long bytes)
        {
            if (bytes <= 0) return true;
            if (budget.TryTake(bytes, namesFloor))
            {
                Taken += bytes;
                return true;
            }
            return creditLeft > 0 && TryCharge(bytes, namesFloor);
        }

        private bool Charge(long bytes, bool name) => !bigQuery ? TryCharge(bytes, 0) : name ? TryChargeName(bytes) : TryCharge(bytes, detailsFloor);

        public override void Sane(long bytes)
        {
            if (bytes > Math.Max(0, budget.Free) + creditLeft) throw Budget();
        }

        public override object? Text(object value, TextUse use)
        {
            var needed = (use & (TextUse.Name | TextUse.ChildName)) != 0;
            // A string no entry names is the name of a row the read then left out (a child whose parent the login cannot
            // see): taken as a name is, though the load does without it when it does not fit.
            var name = (use & TextUse.Name) != 0 || use == TextUse.None && value is string;
            // A definition gives way to names.
            var keepFree = !bigQuery ? needed || name ? 0 : limits.NamesReserveBytes : name ? namesFloor : needed ? detailsFloor : Math.Max(detailsFloor, limits.NamesReserveBytes);
            var acquired = pool.TryAcquire(value, keepFree);
            if (acquired is not null && !(bigQuery && name ? TryChargeName(IndexMemory.SlotBytes) : TryCharge(IndexMemory.SlotBytes, keepFree)))
            {
                pool.Release([acquired]);
                acquired = null;
            }
            if (acquired is null && needed) throw Budget();
            return acquired;
        }

        public override void Records(long own, long detailChildren)
        {
            if (!Charge(own * IndexMemory.RecordBytes, name: true) || !Charge(detailChildren * IndexMemory.RecordBytes, name: false)) throw Budget();
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
            Taken = Credited = creditLeft = 0;
        }
    }

    /// <summary>The shared resource set's load: nothing is pooled or charged here, since <see cref="ResourceCatalog"/> does both
    /// when it shares the table, as it does a read's. What that will cost is only kept within <paramref name="most"/>.</summary>
    internal sealed class PlainAccount(long most) : Account
    {
        private long total;

        private void Add(long bytes)
        {
            total += bytes;
            if (total > most) throw Budget();
        }

        public override void Sane(long bytes)
        {
            if (bytes > most - total) throw Budget();
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

    /// <summary>
    /// Reads a unit's content, checking it as it goes and charging <paramref name="account"/> before it keeps anything.
    /// <paramref name="held"/> receives every text the account answered (a failed load gives those back). Without
    /// <paramref name="children"/> the columns, indexes, statistics and parameters, their names and the details are read past
    /// and not kept, as a read without children keeps none.
    /// </summary>
    public static LoadedUnit Load(Reader reader, IndexFileHeader header, Account account, bool children, List<object?> held, CancellationToken token)
    {
        var kind = header.Kind;
        var resource = kind == IndexUnitKind.Resource;
        if (header.Provider != ProviderOf(kind)) throw Corrupt();

        var unitFlags = reader.UInt16();
        if ((unitFlags & ~UnitFlags) != 0) throw Corrupt();
        bool Has(ushort flag) => (unitFlags & flag) != 0;
        var dataset = kind == IndexUnitKind.Dataset;
        if (Has(DatasetFlag) != dataset || Has(FactsFlag) != dataset || Has(DetailedFlag) && !dataset || Has(CaseSensitiveFlag) && !Has(CaseKnownFlag)
            || resource && (unitFlags & ~DefinitionsLeftOutFlag) != 0 || header.Definitions == Has(DefinitionsLeftOutFlag) || header.Children == Has(ChildrenLeftOutFlag)) throw Corrupt();
        var name = reader.Text(IndexFileLimits.NameChars);
        var datasetName = dataset ? reader.Text(IndexFileLimits.NameChars) : null;
        var (modules, cut, leftOut) = (reader.Int32(), reader.Int32(), reader.Int32());
        if (modules < 0 || cut < 0 || leftOut < 0 || leftOut > cut) throw Corrupt();
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

        // The texts' forms and uses: what the entries are checked against, and how each text will be charged. A load will
        // charge each text its slot; one without children keeps a tag and a place for each of the file's texts meanwhile.
        var textCount = reader.Count(IndexFileLimits.Texts);
        account.Sane(textCount * (children ? IndexMemory.SlotBytes : 5));
        var tags = new byte[textCount];
        reader.Bytes(tags);
        var packedCount = 0;
        const byte OwnUses = (byte)(TextUse.Name | TextUse.Definition);
        foreach (var tag in tags)
        {
            var (form, use) = (tag & 3, tag >> 2);
            if (form > PackedForm || use > 15 || form == NoText && use != 0 || form == PackedForm && (use & (byte)(TextUse.Name | TextUse.ChildName)) != 0) throw Corrupt();
            if (form == PackedForm) packedCount++;
        }

        // Entries. The file states how many are detail children, so the entries this load keeps are charged before there is
        // anywhere to put them; their flags and shapes, which come first, then say which they are. Without children the others
        // are read past: moved says where each of the file's entries is kept, or -1.
        var count = reader.Count(resource ? IndexFileLimits.ResourceObjects : IndexFileLimits.Objects);
        var detailEntries = reader.Count(count, IndexFileProblem.Corrupt);
        if (count != header.Objects) throw Corrupt();
        var ownEntries = count - detailEntries;
        if (!children) account.Sane(count * 5L);
        account.Records(ownEntries, children ? detailEntries : 0);
        var entries = new ObjectEntry[children ? count : ownEntries];
        var moved = children ? null : new int[count];
        var fileFlags = children ? null : new byte[count];
        var bytes = new byte[Batch];
        for (var from = 0; from < count; from += Batch)
        {
            var run = bytes.AsSpan(0, Math.Min(Batch, count - from));
            reader.Bytes(run);
            if (fileFlags is not null) run.CopyTo(fileFlags.AsSpan(from));
            else
                for (var at = 0; at < run.Length; at++) entries[from + at].Flags = run[at];
        }
        var shapeIds = new ushort[Batch];
        var kept = 0;
        for (var from = 0; from < count; from += Batch)
        {
            var run = shapeIds.AsSpan(0, Math.Min(Batch, count - from));
            reader.UInt16s(run);
            for (var at = 0; at < run.Length; at++)
            {
                if (run[at] >= shapeCount) throw Corrupt();
                if (moved is null)
                {
                    entries[from + at].Shape = run[at];
                    if ((entries[from + at].Flags & ObjectTable.ChildFlag) == 0 || !detailShape[run[at]]) kept++;
                    continue;
                }
                var detail = (fileFlags![from + at] & ObjectTable.ChildFlag) != 0 && detailShape[run[at]];
                moved[from + at] = detail ? -1 : kept;
                if (detail) continue;
                // More entries to keep than the file stated, and the load charged.
                if (kept == entries.Length) throw Corrupt();
                (entries[kept].Flags, entries[kept].Shape) = (fileFlags[from + at], run[at]);
                kept++;
            }
        }
        if (kept != ownEntries) throw Corrupt();
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
                    var to = moved is null ? from + at : moved[from + at];
                    if (to < 0)
                    {
                        // A column's expression goes with the column: no longer a module, nor cut. Its date, if it has one
                        // elsewhere, goes too.
                        if (column == 3 && value >= 0) modules--;
                        if (column == 3 && (fileFlags![from + at] & ObjectTable.CutFlag) != 0) cut--;
                        if (column == 4 && unchecked((uint)value) == uint.MaxValue) elsewhere++;
                        continue;
                    }
                    ref var entry = ref entries[to];
                    switch (column)
                    {
                        case 0: entry.Name = value; break;
                        case 1: entry.Schema = value; break;
                        case 2:
                            // An owner is named by its place in the file: kept, it is named by its place among the kept.
                            if (moved is not null && value != -1 && ((uint)value >= (uint)count || (value = moved[value]) < 0)) throw Corrupt();
                            entry.Owner = value;
                            break;
                        case 3: entry.Definition = value; break;
                        default: entry.Modified = unchecked((uint)value); break;
                    }
                }
            }
        fileFlags = null;
        CheckEntries(entries, tags, shapeCount);
        int Moved(int at) => moved is null ? at : moved[at];

        // Dates: one for each entry whose 32 bits say "elsewhere", in entry order.
        var keptElsewhere = 0;
        foreach (ref readonly var entry in entries.AsSpan())
            if (entry.Modified == uint.MaxValue) keptElsewhere++;
        var dateCount = reader.Count(count, IndexFileProblem.Corrupt);
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
        if (!children) reader.Skip(typeCount * 14L + typedCount * 13L + keyCount * 14L + keyColumnCount * 5L);
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
            CheckDetails(parts, entries, tags);
        }
        token.ThrowIfCancellationRequested();

        // The uses the file states decide how each text is charged, so they must be the entries' own. Without the details
        // and the entries read past (a load without children), only the uses of what it keeps can be told.
        var uses = Uses(entries, detailShape, parts, textCount);
        var compared = children ? (byte)15 : OwnUses;
        for (var id = 0; id < textCount; id++)
            if ((tags[id] >> 2 & compared) != (uses[id] & compared)) throw Corrupt();

        // What the content holds whole, for the charge the file states.
        var whole = count * IndexMemory.RecordBytes + detailBytes;
        foreach (var tag in tags)
            if ((tag & 3) != NoText) whole += IndexMemory.SlotBytes;

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
                var fact = new BigQueryObjectFacts(created, Stated(FactDetailed), rows, size, partitioning, clustering, signature, Stated(FactWhole), Stated(FactColumnsCut), listed);
                // Facts are an object's, never a column's, so a load without children keeps them all.
                if (Moved(at) < 0 || (entries[Moved(at)].Flags & ObjectTable.ChildFlag) != 0) throw Corrupt();
                var cost = FactBytesOf(fact);
                whole += cost;
                account.Fact(cost);
                objects[Moved(at)] = fact;
            }
            var descriptionCount = reader.Count(count, IndexFileProblem.Corrupt);
            descriptions = [];
            for (int item = 0, last = -1; item < descriptionCount; item++)
            {
                if ((item & (Batch - 1)) == 0) token.ThrowIfCancellationRequested();
                var at = reader.Int32();
                if (at <= last || at >= count) throw Corrupt();
                last = at;
                var description = reader.Text(IndexFileLimits.FactChars);
                // A description is a column's: it goes with the columns.
                if (moved is not null ? moved[at] >= 0 : (entries[at].Flags & ObjectTable.ChildFlag) == 0 || !detailShape[entries[at].Shape]) throw Corrupt();
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

        // Texts, last: names first (the strings), then long definitions. A load without children numbers the texts it keeps
        // afresh (map: a file's id to the kept one, or -1).
        bool Kept(byte tag) => (tag & 3) != NoText && (children || (tag >> 2 & OwnUses) != 0);
        var map = children ? null : new int[textCount];
        if (children) SetCount(held, textCount);
        else Array.Fill(map!, -1);
        void Hold(int id, object value)
        {
            var copy = account.Text(value, (TextUse)(tags[id] >> 2));
            if (map is null) held[id] = copy;
            else if (copy is not null)
            {
                map[id] = held.Count;
                held.Add(copy);
            }
        }
        for (var id = 0; id < textCount; id++)
        {
            if ((id & (Batch - 1)) == 0) token.ThrowIfCancellationRequested();
            if ((tags[id] & 3) != StringText) continue;
            var chars = reader.Count(IndexFileLimits.TextChars);
            if (Kept(tags[id])) Hold(id, reader.Chars(chars));
            else reader.Skip(2L * chars);
        }
        if (reader.Int32() != packedCount) throw Corrupt();
        var (lengths, byteLengths, frameLengths) = (new int[packedCount], new int[packedCount], new int[packedCount]);
        reader.Int32s(lengths);
        reader.Int32s(byteLengths);
        reader.Int32s(frameLengths);
        var scratch = new PackedText.Scratch();
        for (int id = 0, item = 0; id < textCount; id++)
        {
            if ((tags[id] & 3) != PackedForm) continue;
            token.ThrowIfCancellationRequested();
            var (length, byteLength, frameLength) = (lengths[item], byteLengths[item], frameLengths[item]);
            item++;
            if (length <= 0 || length > IndexFileLimits.TextChars || byteLength < length || byteLength > 3L * length || frameLength <= 0 || frameLength > PackedText.MaxFrameLength(byteLength)) throw Corrupt();
            if (!Kept(tags[id]))
            {
                reader.Skip(frameLength);
                continue;
            }
            var frame = new byte[frameLength];
            reader.Bytes(frame);
            Hold(id, PackedText.FromFrame(frame, length, byteLength, scratch) ?? throw Corrupt());
        }

        // Each kept entry names its texts by where they are held now. An entry whose definition was not kept loses it, as a
        // read that could not keep a definition counts it: cut, and left out for memory.
        int Place(int id) => map is not null ? map[id] : held[id] is null ? -1 : id;
        for (var at = 0; at < entries.Length; at++)
        {
            ref var entry = ref entries[at];
            if ((entry.Name = Place(entry.Name)) < 0 || entry.Schema >= 0 && (entry.Schema = Place(entry.Schema)) < 0) throw Corrupt();
            if (entry.Definition < 0 || (entry.Definition = Place(entry.Definition)) >= 0) continue;
            if ((entry.Flags & ObjectTable.CutFlag) == 0) cut++;
            entry.Flags &= unchecked((byte)~ObjectTable.CutFlag);
            modules--;
            leftOut++;
            // An object whose text the load left out is not whole: the next build reads it again (BigQueryReader).
            if (objects is not null && objects.TryGetValue(at, out var fact)) objects[at] = fact with { Whole = false };
        }
        (modules, cut) = (Math.Max(0, modules), Math.Max(0, cut));

        var extra = new byte[reader.Count(IndexFileLimits.ExtraBytes)];
        reader.Bytes(extra);
        reader.End();

        // The charge the file states is the read's: its content, and what the read charged for rows it then left out. The
        // shared set's is its records and details, which the catalog works out again.
        var stated = header.MemoryBytes;
        if (resource ? stated != count * IndexMemory.RecordBytes + detailBytes : stated < whole || stated - whole > whole + ChargeSlack) throw Corrupt();
        if (children && !resource) account.Rest(stated - whole);

        var table = ObjectTable.FromParts(entries, held.ToArray(), shapeList, dates, parts is null ? null : ObjectDetails.FromParts(parts));
        return new(name, datasetName, table, dataset ? new BigQueryFacts(objects!, descriptions!, shards!) : null, modules, cut, leftOut, Has(ChildrenLeftOutFlag) || !children,
            Has(DefinitionsLeftOutFlag), Has(DetailedFlag) && children, Has(FailedPartFlag), Has(CaseKnownFlag) ? Has(CaseSensitiveFlag) : null, Has(DottedIFlag), key, extra);
    }

    /// <summary>Gives <paramref name="list"/> <paramref name="count"/> empty places, to be filled by id.</summary>
    private static void SetCount(List<object?> list, int count)
    {
        list.Capacity = count;
        System.Runtime.InteropServices.CollectionsMarshal.SetCount(list, count);
        System.Runtime.InteropServices.CollectionsMarshal.AsSpan(list).Clear();
    }
}
