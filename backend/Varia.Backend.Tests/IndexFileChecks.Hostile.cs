using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>The index file as hostile input: every way a file can be wrong answers its reason, a file that is sealed correctly
/// around content that breaks a rule is refused by the content's own checks (in clear text nothing else stands in the way), a
/// seeded fuzz pass never throws and never yields a table its readers cannot walk, a write replaces its target whole or not at
/// all, and the committed files of each format version load to what they held.</summary>
internal static partial class IndexFileChecks
{
    // ---- Taking a file apart and sealing one, as a writer would ----

    /// <summary>A file's content: its chunks opened and its blocks unpacked.</summary>
    internal static byte[] Payload(byte[] file, IndexFileProtection protection)
    {
        using var stream = new MemoryStream(file, writable: false);
        var (_, seal, headerBytes) = IndexFileContainer.ReadHeader(stream, protection.Key);
        using var sealing = seal;
        var chunks = new IndexFileContainer.ChunkReader(stream, seal, headerBytes, default);
        var blocks = new MemoryStream();
        var buffer = new byte[65536];
        for (int got; (got = chunks.Read(buffer)) > 0;) blocks.Write(buffer, 0, got);
        var raw = blocks.ToArray();
        var content = new MemoryStream();
        for (var at = 0; at < raw.Length;)
        {
            var size = (int)BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(at + 1));
            if (raw[at] == 0)
            {
                content.Write(raw, at + 5, size);
                at += 5 + size;
                continue;
            }
            var stored = (int)BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(at + 5));
            var room = new byte[size];
            if (!ZstandardDecoder.TryDecompress(raw.AsSpan(at + 9, stored), room, out var written) || written != size) throw new InvalidOperationException("A block did not unpack.");
            content.Write(room);
            at += 9 + stored + Padding(size, stored);
        }
        return content.ToArray();
    }

    /// <summary>The padding after a compressed block: what keeps it within the format's ratio (IndexFileContainer.MaxRatio).</summary>
    private static int Padding(int raw, int stored) => Math.Max(0, (raw + IndexFileContainer.MaxRatio - 1) / IndexFileContainer.MaxRatio - stored);

    internal static IndexFileHeader Header(byte[] file, IndexFileProtection protection)
    {
        using var stream = new MemoryStream(file, writable: false);
        return IndexFile.ReadHeader(stream, protection).Value ?? throw new InvalidOperationException("The checks' file has no header.");
    }

    /// <summary>A file of <paramref name="header"/> around <paramref name="payload"/>, sealed as a writer seals one: what a
    /// writer with a fault could leave under the key, or anyone in clear text.</summary>
    internal static byte[] Forge(IndexFileHeader header, byte[] payload, IndexFileProtection protection)
    {
        using var stream = new MemoryStream();
        var (seal, _) = IndexFileContainer.WriteHeader(stream, header, protection.Key);
        using var sealing = seal;
        var writer = new IndexFileContainer.PayloadWriter(new IndexFileContainer.ChunkWriter(stream, seal, 0, default));
        writer.Bytes(payload);
        writer.Finish();
        return stream.ToArray();
    }

    /// <summary>A unit's content as plain values, written here by the layout the format documents (not by the product's
    /// writer), so that one value at a time can be made wrong.</summary>
    private sealed class Raw
    {
        public ushort Flags;
        public string Name = "";
        public string? Dataset;
        public int Modules, Cut, LeftOut;
        public List<(string Kind, string Folder, string? Subtype)> Shapes = [];
        /// <summary>The texts in the file's order (<see cref="Sort"/>), and each one's use.</summary>
        public List<object> Texts = [];
        public List<byte> Tags = [];
        /// <summary>The text counts the file states, where a case states others than the texts'.</summary>
        public int? OwnStrings, Strings, OwnLong, TextCount;
        /// <summary>Where <see cref="Write"/> put the text counts and the entry count.</summary>
        public int TextCountsAt, EntryCountAt;
        public ObjectEntry[] Entries = [];
        public List<(int At, long Value)> Dates = [];
        public ObjectDetails.Parts? Details;
        public List<(int At, BigQueryObjectFacts Fact)>? Facts;
        public List<(int At, string Text)> Descriptions = [];
        public List<(int At, BigQueryShardsDto Group)> Shards = [];
        public byte[] Extra = [];
        public int? DetailEntries;
        /// <summary>Bits added to every fact's flags.</summary>
        public ushort FactFlags;
        /// <summary>The number of dates stated, where a case states another than the dates'.</summary>
        public int? DateCount;
        /// <summary>Leaves out the padding after a long definition's frame.</summary>
        public bool NoFramePadding;

        private bool Detail(in ObjectEntry entry) =>
            (entry.Flags & ObjectTable.ChildFlag) != 0 && entry.Shape < Shapes.Count && Shapes[entry.Shape].Kind is "column" or "index" or "statistic" or "parameter" or "bqColumn";

        public static Raw Of(DatabaseIndex unit)
        {
            var table = unit.Table;
            var raw = new Raw
            {
                Flags = (ushort)((unit.ChildrenLeftOut ? 1 : 0) | (unit.DefinitionsLeftOut ? 2 : 0) | (unit.Detailed ? 4 : 0) | (unit.FailedPart ? 8 : 0) | (unit.CaseSensitive is not null ? 16 : 0)
                    | (unit.CaseSensitive == true ? 32 : 0) | (unit.DottedI ? 64 : 0) | (unit.Facts is not null ? 128 : 0) | (unit.Dataset is not null ? 256 : 0)),
                Name = unit.Database, Dataset = unit.Dataset, Modules = unit.Modules, Cut = unit.Cut, LeftOut = unit.LeftOut,
                Shapes = [.. table.Shapes.Select(shape => (shape.Kind, shape.Folder, shape.Subtype))], Texts = [.. table.Texts.Select(text => text!)], Entries = table.Entries.ToArray(),
                Dates = [.. (table.Dates ?? new Dictionary<int, DateTime>()).OrderBy(pair => pair.Key).Select(pair => (pair.Key, pair.Value.Ticks | (long)pair.Value.Kind << 62))],
                Details = table.Details?.ToParts() is { } parts ? Copy(parts) : null
            };
            if (unit.Facts is { } facts)
            {
                raw.Facts = [.. facts.Objects.OrderBy(pair => pair.Key).Select(pair => (pair.Key, pair.Value))];
                raw.Descriptions = [.. facts.Descriptions.OrderBy(pair => pair.Key).Select(pair => (pair.Key, pair.Value))];
                raw.Shards = [.. facts.ShardGroups.OrderBy(pair => pair.Key).Select(pair => (pair.Key, pair.Value))];
            }
            raw.Retag();
            raw.Sort();
            return raw;
        }

        /// <summary>Puts the texts in the file's order (the strings a load without children keeps, the other strings, the long
        /// definitions it keeps, the others) and has the entries and the types name them by their new places.</summary>
        public void Sort()
        {
            int Group(int id) => Texts[id] is string ? (Tags[id] & 5) != 0 ? 0 : 1 : (Tags[id] & 4) != 0 ? 2 : 3;
            var order = Enumerable.Range(0, Texts.Count).OrderBy(Group).ToArray();
            var place = new int[order.Length];
            for (var to = 0; to < order.Length; to++) place[order[to]] = to;
            int Placed(int id) => (uint)id < (uint)place.Length ? place[id] : id;
            (Texts, Tags) = ([.. order.Select(id => Texts[id])], [.. order.Select(id => Tags[id])]);
            for (var at = 0; at < Entries.Length; at++) (Entries[at].Name, Entries[at].Schema, Entries[at].Definition) = (Placed(Entries[at].Name), Placed(Entries[at].Schema), Placed(Entries[at].Definition));
            for (var type = 0; Details is not null && type < Details.TypeName.Length; type++) (Details.TypeName[type], Details.TypeSchema[type]) = (Placed(Details.TypeName[type]), Placed(Details.TypeSchema[type]));
        }

        private static ObjectDetails.Parts Copy(ObjectDetails.Parts parts) => new([.. parts.TypeName], [.. parts.TypeSchema], [.. parts.TypeId], [.. parts.TypeSystem], [.. parts.TypeFlags],
            [.. parts.TypedAt], [.. parts.TypedType], [.. parts.TypedLength], [.. parts.TypedPrecision], [.. parts.TypedScale], [.. parts.TypedOrdinal], [.. parts.TypedFlags], [.. parts.KeyAt],
            [.. parts.KeyFrom], [.. parts.KeyCount], [.. parts.KeyReferenced], [.. parts.KeyColumn], [.. parts.KeyOther], [.. parts.KeyColumnFlags]);

        /// <summary>Each text's tag from the entries and details as they are now (a reference out of range is left for the loader to find).</summary>
        public void Retag()
        {
            var uses = new byte[Texts.Count];
            void Use(int id, int use)
            {
                if ((uint)id >= (uint)uses.Length) return;
                // 16: named by a kept entry only after something else named it.
                if (use == 1 && uses[id] != 0 && (uses[id] & 1) == 0) uses[id] |= 16;
                uses[id] |= (byte)use;
            }
            var typed = 0;
            for (var at = 0; at < Entries.Length; at++)
            {
                var entry = Entries[at];
                var detail = Detail(entry);
                Use(entry.Name, detail ? 2 : 1);
                Use(entry.Schema, detail ? 2 : 1);
                Use(entry.Definition, detail ? 8 : 4);
                for (; Details is not null && typed < Details.TypedAt.Length && Details.TypedAt[typed] <= at; typed++)
                    if (Details.TypedType[typed] < Details.TypeName.Length)
                    {
                        Use(Details.TypeName[Details.TypedType[typed]], 2);
                        Use(Details.TypeSchema[Details.TypedType[typed]], 2);
                    }
            }
            if (Details is not null)
                for (var type = 0; type < Details.TypeName.Length; type++)
                {
                    Use(Details.TypeName[type], 2);
                    Use(Details.TypeSchema[type], 2);
                }
            Tags = [.. uses];
        }

        public long Whole => Entries.Length * IndexMemory.RecordBytes + Texts.Count * IndexMemory.SlotBytes + (Details is null ? 0 : ObjectDetails.FromParts(Details).Bytes)
            + (Facts ?? []).Sum(item => BigQueryFacts.ObjectBytes + Chars(item.Fact.Signature) + Chars(item.Fact.Partitioning) + Chars(item.Fact.Clustering))
            + Descriptions.Sum(item => BigQueryFacts.DescriptionBytes + Chars(item.Text)) + Shards.Sum(item => BigQueryFacts.ShardBytes + Chars(item.Group.Prefix) + Chars(item.Group.First) + Chars(item.Group.Last));

        private static long Chars(string? value) => value is null ? 0 : IndexMemory.StringBytes(value.Length);

        public byte[] Write()
        {
            var stream = new MemoryStream();
            using var writer = new BinaryWriter(stream, Encoding.Unicode);
            void Text(string value)
            {
                writer.Write(value.Length);
                // Unit by unit: an encoding would replace an unpaired surrogate.
                foreach (var unit in value) writer.Write((ushort)unit);
            }
            writer.Write(Flags);
            Text(Name);
            if (Dataset is not null) Text(Dataset);
            writer.Write(Modules);
            writer.Write(Cut);
            writer.Write(LeftOut);
            writer.Write(Shapes.Count);
            foreach (var (kind, folder, subtype) in Shapes)
            {
                Text(kind);
                Text(folder);
                writer.Write(subtype is null ? (byte)0 : (byte)1);
                if (subtype is not null) Text(subtype);
            }
            writer.Flush();
            TextCountsAt = (int)stream.Position;
            writer.Write(OwnStrings ?? Enumerable.Range(0, Texts.Count).Count(id => Texts[id] is string && (Tags[id] & 5) != 0));
            writer.Write(Strings ?? Texts.Count(text => text is string));
            writer.Write(OwnLong ?? Enumerable.Range(0, Texts.Count).Count(id => Texts[id] is PackedText && (Tags[id] & 4) != 0));
            writer.Write(TextCount ?? Texts.Count);
            writer.Flush();
            EntryCountAt = (int)stream.Position;
            writer.Write(Entries.Length);
            writer.Write(DetailEntries ?? Entries.Count(entry => Detail(entry)));
            foreach (var entry in Entries)
            {
                writer.Write(entry.Flags);
                writer.Write(entry.Shape);
            }
            foreach (var entry in Entries) writer.Write(entry.Name);
            foreach (var entry in Entries) writer.Write(entry.Schema);
            foreach (var entry in Entries) writer.Write(entry.Owner);
            foreach (var entry in Entries) writer.Write(entry.Definition);
            foreach (var entry in Entries) writer.Write(entry.Modified);
            writer.Write(DateCount ?? Dates.Count);
            foreach (var (at, value) in Dates)
            {
                writer.Write(at);
                writer.Write(value);
            }
            writer.Write(Details?.TypeName.Length ?? 0);
            writer.Write(Details?.TypedAt.Length ?? 0);
            writer.Write(Details?.KeyAt.Length ?? 0);
            writer.Write(Details?.KeyColumn.Length ?? 0);
            if (Details is { } parts)
            {
                foreach (var value in parts.TypeName) writer.Write(value);
                foreach (var value in parts.TypeSchema) writer.Write(value);
                foreach (var value in parts.TypeId) writer.Write(value);
                writer.Write(parts.TypeSystem);
                writer.Write(parts.TypeFlags);
                foreach (var value in parts.TypedAt) writer.Write(value);
                foreach (var value in parts.TypedType) writer.Write(value);
                foreach (var value in parts.TypedLength) writer.Write(value);
                writer.Write(parts.TypedPrecision);
                writer.Write(parts.TypedScale);
                foreach (var value in parts.TypedOrdinal) writer.Write(value);
                writer.Write(parts.TypedFlags);
                foreach (var value in parts.KeyAt) writer.Write(value);
                foreach (var value in parts.KeyFrom) writer.Write(value);
                foreach (var value in parts.KeyCount) writer.Write(value);
                foreach (var value in parts.KeyReferenced) writer.Write(value);
                foreach (var value in parts.KeyColumn) writer.Write(value);
                foreach (var value in parts.KeyOther) writer.Write(value);
                writer.Write(parts.KeyColumnFlags);
            }
            if (Facts is not null)
            {
                writer.Write(Facts.Count);
                foreach (var (at, fact) in Facts)
                {
                    writer.Write(at);
                    writer.Write(fact.Created);
                    writer.Write((ushort)((fact.Detailed ? 1 : 0) | (fact.Whole ? 2 : 0) | (fact.ColumnsCut ? 4 : 0) | (fact.Rows is not null ? 8 : 0) | (fact.Bytes is not null ? 16 : 0)
                        | (fact.Listed is not null ? 32 : 0) | (fact.Partitioning is not null ? 64 : 0) | (fact.Clustering is not null ? 128 : 0) | (fact.Signature is not null ? 256 : 0)
                        | (fact.Stale ? 512 : 0) | FactFlags));
                    if (fact.Rows is { } rows) writer.Write(rows);
                    if (fact.Bytes is { } bytes) writer.Write(bytes);
                    if (fact.Listed is { } listed) writer.Write(listed);
                    if (fact.Partitioning is { } partitioning) Text(partitioning);
                    if (fact.Clustering is { } clustering) Text(clustering);
                    if (fact.Signature is { } signature) Text(signature);
                }
                writer.Write(Descriptions.Count);
                foreach (var (at, text) in Descriptions)
                {
                    writer.Write(at);
                    Text(text);
                }
                writer.Write(Shards.Count);
                foreach (var (at, group) in Shards)
                {
                    writer.Write(at);
                    Text(group.Prefix);
                    writer.Write(group.Count);
                    Text(group.First);
                    Text(group.Last);
                }
            }
            for (var id = 0; id < Texts.Count; id++)
                if (Texts[id] is string value)
                {
                    writer.Write(Tags[id]);
                    Text(value);
                }
            for (var id = 0; id < Texts.Count; id++)
                if (Texts[id] is PackedText frame)
                {
                    writer.Write(Tags[id]);
                    writer.Write(frame.Length);
                    writer.Write(frame.ByteLength);
                    writer.Write(frame.FrameLength);
                    writer.Write(frame.Frame);
                    if (!NoFramePadding) writer.Write(new byte[Padding(frame.ByteLength, frame.FrameLength)]);
                }
            writer.Write(Extra.Length);
            writer.Write(Extra);
            writer.Flush();
            return stream.ToArray();
        }
    }

    // ---- Reasons ----

    private static async Task Refusals(Action<bool, string> check)
    {
        var source = new World();
        var unit = await Database(source);
        var dataset = Dataset(source, DatasetEntries());
        foreach (var (mode, protection) in Modes)
        {
            var file = Save(unit, IndexUnitKind.Database, protection);
            var other = protection.IsEncrypted ? Clear : Sealed;
            var world = new World();
            IndexFileProblem Problem(byte[] bytes, IndexUnitKind kind = IndexUnitKind.Database, IndexFileProtection? with = null, byte[]? identity = null, CancellationToken token = default)
            {
                var loaded = Load(world, bytes, kind, with ?? protection, identity: identity, token: token);
                if (loaded.Value is not null) world.Connection.Abandon(loaded.Value);
                using var stream = new MemoryStream(bytes, writable: false);
                var header = IndexFile.ReadHeader(stream, with ?? protection).Problem;
                // The header alone answers the same reason for everything that is wrong before the body.
                if (loaded.Problem is IndexFileProblem.NotIndexFile or IndexFileProblem.Version or IndexFileProblem.Mode or IndexFileProblem.Key && header != loaded.Problem) return IndexFileProblem.None;
                return world.Empty ? loaded.Problem : IndexFileProblem.None;
            }
            byte[] With(int at, byte value)
            {
                var copy = (byte[])file.Clone();
                copy[at] = value;
                return copy;
            }

            var random = new byte[4096];
            new Random(7).NextBytes(random);
            check(Problem(random) == IndexFileProblem.NotIndexFile && Problem("VARIAIDY"u8.ToArray()) == IndexFileProblem.NotIndexFile && Problem(Encoding.UTF8.GetBytes("{\"index\":true}")) == IndexFileProblem.NotIndexFile,
                $"bytes that do not start as an index file are not one ({mode})");
            check(Problem([]) == IndexFileProblem.Truncated && Problem("VARIA"u8.ToArray()) == IndexFileProblem.Truncated && Problem(file[..40]) == IndexFileProblem.Truncated,
                $"a file that ends inside its prefix is truncated ({mode})");
            // The version is the first thing read after the magic: a newer file may lay out everything after it differently.
            var newer = With(8, (byte)(IndexFileContainer.Version + 1));
            var newerStill = With(9, 1);
            check(Problem(newer) == IndexFileProblem.Version && Problem(With(8, 0)) == IndexFileProblem.Version && Problem(newerStill) == IndexFileProblem.Version
                && Problem([.. newer[..20], .. random]) == IndexFileProblem.Version && Problem(newer, with: other) == IndexFileProblem.Version,
                $"a file of another format version, older or newer, is refused as that before anything else in it is read ({mode})");
            check(Problem(file, with: other) == IndexFileProblem.Mode, $"a file is never read in the other mode: {(protection.IsEncrypted ? "encrypted, with no key given" : "clear text, with a key given")}");
            if (protection.IsEncrypted)
            {
                var wrong = IndexFileProtection.Encrypted([.. TestKey.Select(value => (byte)(value ^ 1))]);
                check(Problem(file, with: wrong) == IndexFileProblem.Key, "a file under another key does not open");
                check(Problem(With(25, (byte)(file[25] ^ 4))) == IndexFileProblem.Key && Problem(With(IndexFileContainer.PrefixBytes + 3, (byte)(file[IndexFileContainer.PrefixBytes + 3] ^ 1))) == IndexFileProblem.Key
                    && Problem(With(16, (byte)(file[16] ^ 1))) is IndexFileProblem.Key or IndexFileProblem.Truncated or IndexFileProblem.Corrupt,
                    "a changed salt, header or header length does not open either: the header's tag covers the prefix");
            }
            check(Problem(file, identity: [.. Identity, 0]) == IndexFileProblem.Identity && Problem(file, identity: [.. Identity[..^1]]) == IndexFileProblem.Identity
                && Problem(file, identity: []) == IndexFileProblem.Identity, $"a file with another identity than the caller's is refused ({mode})");
            check(Problem(file, IndexUnitKind.Server) == IndexFileProblem.Kind && Problem(file, IndexUnitKind.Dataset) == IndexFileProblem.Kind
                && Problem(Save(dataset, IndexUnitKind.Dataset, protection), IndexUnitKind.Database) == IndexFileProblem.Kind, $"a file of another kind of unit than the caller asked for is refused ({mode})");
            using (var stopped = new CancellationTokenSource())
            {
                stopped.Cancel();
                check(Problem(file, token: stopped.Token) == IndexFileProblem.Cancelled, $"a load the caller stops answers that ({mode})");
            }
            using (var failing = new Failing(file, failAt: 200))
                check(IndexFile.Load(failing, new IndexLoadOptions(protection, IndexUnitKind.Database, Identity), world.Limits, world.Pool).Problem == IndexFileProblem.Io && world.Empty
                    && IndexFile.LoadFile(Path.Combine(Path.GetTempPath(), "varia-index-checks-missing", "none.vidx"), new IndexLoadOptions(protection, IndexUnitKind.Database, Identity), world.Limits, world.Pool).Problem == IndexFileProblem.Io
                    && IndexFile.ReadHeaderFile(Path.Combine(Path.GetTempPath(), "varia-index-checks-missing", "none.vidx"), protection).Problem == IndexFileProblem.Io,
                    $"a file that cannot be read, or is not there, is an I/O problem as a value ({mode})");

            // Cut anywhere, the file is truncated, never loaded; with anything after its last chunk it is corrupt.
            var cuts = Enumerable.Range(0, file.Length).Select(length => Problem(file[..length])).Distinct().ToList();
            check(cuts is [IndexFileProblem.Truncated], $"a file cut short at any of its {file.Length} lengths is truncated ({mode}): {string.Join(", ", cuts)}");
            check(Problem([.. file, 0]) == IndexFileProblem.Corrupt && Problem([.. file, .. file]) == IndexFileProblem.Corrupt, $"bytes after a file's last chunk make it corrupt ({mode})");

            // Any one bit changed anywhere: refused, by a reason that fits where the bit is.
            var reasons = new Dictionary<IndexFileProblem, int>();
            var loadedAnyway = 0;
            for (var at = 0; at < file.Length; at++)
            {
                var problem = Problem(With(at, (byte)(file[at] ^ 1 << at % 8)));
                if (problem == IndexFileProblem.None) loadedAnyway++;
                reasons[problem] = reasons.GetValueOrDefault(problem) + 1;
            }
            check(loadedAnyway == 0 && reasons.Keys.All(reason => reason is IndexFileProblem.NotIndexFile or IndexFileProblem.Version or IndexFileProblem.Mode or IndexFileProblem.Key or IndexFileProblem.Corrupt or IndexFileProblem.Truncated),
                $"a file with any one bit changed is refused ({mode}): {string.Join(", ", reasons.OrderBy(pair => pair.Key).Select(pair => pair.Key + " " + pair.Value))}");
        }

        // What a save refuses, before it writes a byte.
        {
            var options = new IndexSaveOptions(Sealed, Identity);
            IndexFileProblem Saved(DatabaseIndex value, IndexUnitKind kind, IndexSaveOptions? with = null)
            {
                using var stream = new MemoryStream();
                var problem = IndexFile.Save(stream, value, kind, with ?? options);
                return stream.Length == 0 || problem == IndexFileProblem.None ? problem : IndexFileProblem.None;
            }
            using var stopped = new CancellationTokenSource();
            stopped.Cancel();
            check(Saved(unit, IndexUnitKind.Database, options with { Identity = new byte[IndexFileLimits.IdentityBytes + 1] }) == IndexFileProblem.Limits
                && Saved(unit, IndexUnitKind.Database, options with { Sync = new byte[IndexFileLimits.SyncBytes + 1] }) == IndexFileProblem.Limits
                && Saved(unit, IndexUnitKind.Database, options with { Extra = new byte[IndexFileLimits.ExtraBytes + 1] }) == IndexFileProblem.Limits
                && Saved(unit, IndexUnitKind.Database, options with { Identity = new byte[IndexFileLimits.IdentityBytes], Sync = new byte[IndexFileLimits.SyncBytes] }) == IndexFileProblem.None
                && Saved(new DatabaseIndex("Big", [new IndexedObject("table", "tables", "dbo", new string('n', IndexFileLimits.TextChars + 1))], 0, 0, 0), IndexUnitKind.Database) == IndexFileProblem.Limits
                && Saved(new DatabaseIndex(new string('d', IndexFileLimits.NameChars + 1), [], 0, 0, 0), IndexUnitKind.Database) == IndexFileProblem.Limits
                && IndexFile.Save(new MemoryStream(), unit, IndexUnitKind.Database, options, stopped.Token) == IndexFileProblem.Cancelled,
                "a save refuses a unit, an identity, a sync state or extra bytes past the format's limits, and a stopped save, before it writes anything");
            // A unit the format cannot carry (a dataset saved as a database, a table whose history table is shown below another
            // history table) is refused rather than written as a file no load would take.
            var chained = ObjectTable.Of([new IndexedObject("table", "tables", "dbo", "A"), new IndexedObject("table", "tables", "dbo", "B"), new IndexedObject("table", "tables", "dbo", "C")]);
            var entries = chained.Entries.ToArray();
            (entries[1].Owner, entries[2].Owner) = (0, 1);
            var broken = new DatabaseIndex("Broken", ObjectTable.FromParts(entries, [.. chained.Texts], [.. chained.Shapes], null, null), 0, 0, 0);
            check(Saved(dataset, IndexUnitKind.Database) == IndexFileProblem.Unsupported && Saved(unit, IndexUnitKind.Dataset) == IndexFileProblem.Unsupported && Saved(broken, IndexUnitKind.Database) == IndexFileProblem.Unsupported,
                "a save refuses a unit of the wrong kind, or one whose table breaks a rule a load checks, as unsupported");
            var caught = false;
            try { IndexFileProtection.Encrypted(new byte[16]); }
            catch (ArgumentException) { caught = true; }
            check(caught && !IndexFileProtection.ClearText.IsEncrypted && Sealed.IsEncrypted, "a key is 32 bytes, and clear text is asked for by name, never by leaving the key out");
        }
        source.Connection.Abandon(unit);
        source.Connection.Abandon(dataset);

        await Structure(check);
    }

    /// <summary>A stream that fails once <paramref name="failAt"/> bytes are read, as a disk does.</summary>
    private sealed class Failing(byte[] bytes, int failAt) : Stream
    {
        private int at;

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (at + count > failAt) throw new IOException("The disk failed.");
            var take = Math.Min(count, bytes.Length - at);
            bytes.AsSpan(at, take).CopyTo(buffer.AsSpan(offset));
            at += take;
            return take;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => bytes.Length;
        public override long Position { get => at; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    /// <summary>Content that breaks one rule at a time, inside a file sealed exactly as a writer seals one: each is refused by
    /// the content's own checks, in clear text and under the key alike, with nothing left charged.</summary>
    private static async Task Structure(Action<bool, string> check)
    {
        var source = new World();
        var database = await Database(source);
        var dataset = Dataset(source, DatasetEntries());
        foreach (var (mode, protection) in Modes)
        {
            var world = new World();
            var failures = new List<string>();
            var cases = 0;
            foreach (var (unit, kind) in new[] { (database, IndexUnitKind.Database), (dataset, IndexUnitKind.Dataset) })
            {
                var header = Header(Save(unit, kind, protection), protection);
                IndexLoad<DatabaseIndex> Try(Raw raw, IndexFileHeader? with = null, bool children = true)
                {
                    var loaded = Load(world, Forge(with ?? header, raw.Write(), protection), kind, protection, children: children);
                    if (loaded.Value is not null) world.Connection.Abandon(loaded.Value);
                    return loaded;
                }
                // Written by the documented layout and untouched, the content loads, to the very unit.
                var plain = Load(world, Forge(header, Raw.Of(unit).Write(), protection), kind, protection);
                check(plain.Value is not null && Dump(plain.Value) == Dump(unit), $"a {kind} written by the documented layout, apart from the product's writer, loads to the same unit ({mode}): {plain.Problem}"
                    + (plain.Value is null ? "" : Difference(Dump(unit), Dump(plain.Value))));
                if (plain.Value is not null) world.Connection.Abandon(plain.Value);

                // details: the rule is the details' own, or a detail child's, which a load without children reads past and so
                // does not hold: it then loads the unit, soundly, without them.
                void Refused(string what, Action<Raw> change, IndexFileProblem expected = IndexFileProblem.Corrupt, Func<Raw, IndexFileHeader>? with = null, bool retag = true, bool details = false)
                {
                    var raw = Raw.Of(unit);
                    change(raw);
                    if (retag)
                    {
                        raw.Retag();
                        raw.Sort();
                    }
                    cases++;
                    foreach (var children in new[] { true, false })
                    {
                        var loaded = Try(raw, with?.Invoke(raw), children);
                        if (details && !children && loaded.Problem == IndexFileProblem.None && world.Empty) continue;
                        if (loaded.Problem != expected || !world.Empty) failures.Add($"{kind} {what} (children {children}): {loaded.Problem}, {world.Budget.Used} bytes left");
                    }
                }
                var table = unit.Table;
                int First(Func<int, bool> entry) => Enumerable.Range(0, table.Count).First(entry);
                var child = First(at => table.Parent(at) >= 0);
                var top = First(at => table.Parent(at) < 0 && table.Via(at) < 0);
                var otherTop = Enumerable.Range(0, table.Count).Last(at => table.Parent(at) < 0 && table.Via(at) < 0);
                // A long definition's place in the file's texts, or -1.
                var packedText = Raw.Of(unit).Texts.FindIndex(text => text is PackedText);
                var defined = First(table.HasDefinition);
                // A dataset's children are all columns, which a load without children reads past.
                var passed = IndexFileUnit.DetailChild(table.Kind(child));

                // Entries.
                Refused("a name past the texts", raw => raw.Entries[top].Name = raw.Texts.Count);
                Refused("a negative name", raw => raw.Entries[top].Name = -1);
                Refused("a schema past the texts", raw => raw.Entries[top].Schema = int.MaxValue);
                Refused("a schema below none", raw => raw.Entries[top].Schema = -2);
                Refused("a definition past the texts", raw => raw.Entries[top].Definition = raw.Texts.Count + 5);
                Refused("a definition below none", raw => raw.Entries[top].Definition = int.MinValue);
                Refused("a cut mark on no definition", raw => { raw.Entries[top].Definition = -1; raw.Entries[top].Flags |= ObjectTable.CutFlag; });
                Refused("a removed entry", raw => raw.Entries[top].Flags |= ObjectTable.RemovedFlag);
                Refused("an unknown flag", raw => raw.Entries[top].Flags |= 64);
                Refused("a shape past the shapes", raw => raw.Entries[top].Shape = (ushort)raw.Shapes.Count);
                Refused("a child with no parent", raw => raw.Entries[child].Owner = -1, details: passed);
                Refused("a child of itself", raw => raw.Entries[child].Owner = child, details: passed);
                Refused("a parent past the entries", raw => raw.Entries[child].Owner = raw.Entries.Length, details: passed);
                Refused("a negative owner", raw => raw.Entries[top].Owner = -7);
                Refused("a child of a child", raw => { var kid = Enumerable.Range(0, raw.Entries.Length).First(at => at != child && (raw.Entries[at].Flags & ObjectTable.ChildFlag) != 0); raw.Entries[kid].Owner = child; }, details: passed);
                Refused("a table shown below itself", raw => raw.Entries[top].Owner = top);
                Refused("a table shown below a child", raw => raw.Entries[top].Owner = child);
                Refused("two tables shown below each other", raw => { raw.Entries[top].Owner = otherTop; raw.Entries[otherTop].Owner = top; });
                Refused("fewer entries than the header states", raw => raw.Entries = raw.Entries[..^1], with: raw => header);
                Refused("more detail children than there are", raw => raw.DetailEntries = raw.Entries.Count(entry => (entry.Flags & ObjectTable.ChildFlag) != 0) + 1);
                Refused("fewer detail children than there are", raw => raw.DetailEntries = 0);
                Refused("more detail children than entries", raw => raw.DetailEntries = raw.Entries.Length + 1);
                Refused("a negative number of detail children", raw => raw.DetailEntries = -1);
                if (packedText >= 0)
                {
                    Refused("a long definition as a name", raw => raw.Entries[top].Name = packedText);
                    Refused("a frame that is not zstd", raw => raw.Texts[packedText] = Frame((PackedText)raw.Texts[packedText]!, frame => frame.AsSpan(4).Fill(0xA5)));
                    Refused("a frame with a byte changed", raw => raw.Texts[packedText] = Frame((PackedText)raw.Texts[packedText]!, frame => frame[^3] ^= 0x10));
                    Refused("fewer long definitions kept without children than there are", raw => raw.OwnLong = raw.Texts.Count(text => text is PackedText) - 1 - Enumerable.Range(0, raw.Texts.Count).Count(id => raw.Texts[id] is PackedText && (raw.Tags[id] & 4) == 0));
                }
                // Texts: their numbers, and the use each states.
                Refused("more texts than are written", raw => raw.TextCount = raw.Texts.Count + 1);
                Refused("fewer texts than the entries name", raw => raw.TextCount = raw.Texts.Count - 1);
                Refused("more strings kept without children than strings", raw => raw.OwnStrings = raw.Texts.Count(text => text is string) + 1);
                Refused("fewer strings kept without children than there are", raw => raw.OwnStrings = Enumerable.Range(0, raw.Texts.Count).Count(id => raw.Texts[id] is string && (raw.Tags[id] & 5) != 0) - 1);
                Refused("more strings and long definitions than texts", raw => (raw.Strings, raw.OwnLong) = (raw.Texts.Count, 1));
                Refused("a use that is none known", raw => raw.Tags[0] |= 0x20, retag: false);
                Refused("a text named first by a detail that no kept entry names", raw => raw.Tags[raw.Entries[defined].Definition] |= 16, retag: false);
                Refused("more modules than its entries could hold", raw => raw.Modules = int.MaxValue);
                Refused("more cut definitions than its entries could hold", raw => (raw.Cut, raw.LeftOut) = (int.MaxValue, int.MaxValue));
                Refused("children in a unit that says it was read without them", raw => raw.Flags |= 1, with: raw => header with { Children = false });
                Refused("definitions in a unit that says it was read without them", raw => raw.Flags |= 2, with: raw => header with { Definitions = false });
                Refused("a parent without a schema", raw => raw.Entries[raw.Entries[child].Owner].Schema = -1, details: passed);
                Refused("a name that states a definition's use", raw => raw.Tags[raw.Entries[top].Name] = 4, retag: false);
                Refused("a definition that states a name's use", raw => raw.Tags[raw.Entries[defined].Definition] |= 1, retag: false);
                Refused("a name longer than a name may be", raw => raw.Texts[raw.Entries[top].Name] = new string('x', IndexFileLimits.NameTextChars + 1), IndexFileProblem.Limits);
                Refused("a schema longer than a name may be", raw => raw.Texts[raw.Entries[raw.Entries[child].Owner].Schema] = new string('s', IndexFileLimits.NameTextChars + 1), IndexFileProblem.Limits);
                Refused("a definition longer than the format allows", raw => raw.Texts[raw.Entries[defined].Definition] = new string('d', IndexFileLimits.TextChars + 1), IndexFileProblem.Limits);
                Refused("more dates than the format allows", raw => raw.DateCount = IndexFileLimits.Dates + 1, IndexFileProblem.Limits);
                Refused("a shape longer than the format allows", raw => raw.Shapes[0] = (new string('k', IndexFileLimits.ShapeChars + 1), "f", null), IndexFileProblem.Limits);
                Refused("a name longer than the format allows", raw => raw.Name = new string('n', IndexFileLimits.NameChars + 1), IndexFileProblem.Limits);
                Refused("unknown unit flags", raw => raw.Flags |= 0x4000);
                Refused("a case rule that is not known but sensitive", raw => raw.Flags = (ushort)(raw.Flags & ~16 | 32));
                Refused("definitions the header says are not there", raw => raw.Flags ^= 2);
                Refused("children the header says are not there", raw => raw.Flags ^= 1);
                Refused(kind == IndexUnitKind.Dataset ? "a dataset without facts" : "a database with a dataset's flags", raw => raw.Flags ^= 128);
                Refused("more left out than cut", raw => (raw.Cut, raw.LeftOut) = (1, 2));
                Refused("negative modules", raw => raw.Modules = -1);
                // The charge the header states.
                Refused("a stated charge below its content", raw => { }, with: raw => header with { MemoryBytes = raw.Whole - 1 });
                Refused("a stated charge far above its content", raw => { }, with: raw => header with { MemoryBytes = 2 * raw.Whole + 64 * 1024 + 1 });
                Refused("another provider's unit", raw => { }, with: raw => header with { Provider = kind == IndexUnitKind.Dataset ? IndexProvider.SqlServer : IndexProvider.BigQuery });
                // Dates.
                Refused("a date of no entry", raw => raw.Dates.Add((top, 5)));
                Refused("an entry whose date is nowhere", raw => raw.Entries[top].Modified = uint.MaxValue);
                Refused("a date out of range", raw => { raw.Entries[top].Modified = uint.MaxValue; raw.Dates.Add((top, long.MaxValue)); raw.Dates.Sort(); });
                // Details.
                if (table.Details is not null)
                {
                    Refused("typed entries out of order", raw => { if (raw.Details!.TypedAt.Length > 1) (raw.Details.TypedAt[0], raw.Details.TypedAt[^1]) = (raw.Details.TypedAt[^1], raw.Details.TypedAt[0]); else raw.Details.TypedAt[0] = -1; }, details: true);
                    Refused("a typed entry past the entries", raw => raw.Details!.TypedAt[^1] = raw.Entries.Length, details: true);
                    Refused("a type past the types", raw => raw.Details!.TypedType[0] = (ushort)raw.Details.TypeName.Length, details: true);
                    Refused("a type named by no text", raw => raw.Details!.TypeName[0] = raw.Texts.Count, details: true);
                    Refused("a type schema below none", raw => raw.Details!.TypeSchema[0] = -3, details: true);
                    Refused("unknown type flags", raw => raw.Details!.TypeFlags[0] = 8, details: true);
                    if (packedText >= 0) Refused("a type named by a long definition", raw => raw.Details!.TypeName[0] = packedText, details: true);
                    if (table.Details.KeyCount > 0)
                    {
                        Refused("keys out of order", raw => { if (raw.Details!.KeyAt.Length > 1) (raw.Details.KeyAt[0], raw.Details.KeyAt[^1]) = (raw.Details.KeyAt[^1], raw.Details.KeyAt[0]); }, details: true);
                        Refused("a key past the entries", raw => raw.Details!.KeyAt[^1] = int.MaxValue, details: true);
                        Refused("a key's columns before the list", raw => raw.Details!.KeyFrom[0] = -1, details: true);
                        Refused("a key's columns past the list", raw => raw.Details!.KeyFrom[0] = raw.Details.KeyColumn.Length, details: true);
                        Refused("a key with a negative column count", raw => raw.Details!.KeyCount[0] = -1, details: true);
                        Refused("a key with more columns than the list", raw => raw.Details!.KeyCount[0] = short.MaxValue, details: true);
                        Refused("a key with more columns than a key has", raw => { raw.Details = raw.Details! with { KeyColumn = new short[IndexFileLimits.KeyColumnsPerKey + 8], KeyOther = new short[IndexFileLimits.KeyColumnsPerKey + 8], KeyColumnFlags = new byte[IndexFileLimits.KeyColumnsPerKey + 8] }; (raw.Details.KeyFrom[0], raw.Details.KeyCount[0]) = (0, IndexFileLimits.KeyColumnsPerKey + 1); }, details: true);
                        Refused("a foreign key to no entry", raw => raw.Details!.KeyReferenced[0] = raw.Entries.Length, details: true);
                        Refused("a foreign key below none", raw => raw.Details!.KeyReferenced[0] = -2, details: true);
                        Refused("a foreign key that is no child", raw => { var key = raw.Details!.KeyAt[0]; raw.Details.KeyReferenced[0] = top; raw.Entries[key].Flags &= unchecked((byte)~ObjectTable.ChildFlag); raw.Entries[key].Owner = -1; }, details: true);
                    }
                }
                // BigQuery's facts.
                if (table.Details is { TypedCount: > 1 }) Refused("an entry typed twice", raw => raw.Details!.TypedAt[1] = raw.Details.TypedAt[0], details: true);
                if (table.Details is { KeyCount: > 1 }) Refused("an entry with two lists of key columns", raw => raw.Details!.KeyAt[1] = raw.Details.KeyAt[0], details: true);
                if (unit.Facts is not null)
                {
                    Refused("a child that is no column", raw => { var shape = raw.Entries[child].Shape; raw.Shapes[shape] = ("bqField", raw.Shapes[shape].Folder, raw.Shapes[shape].Subtype); });
                    Refused("facts of no entry", raw => raw.Facts![^1] = (raw.Entries.Length, raw.Facts[^1].Fact));
                    Refused("facts out of order", raw => (raw.Facts![0], raw.Facts[1]) = (raw.Facts[1], raw.Facts[0]));
                    Refused("facts given twice", raw => raw.Facts![1] = (raw.Facts[0].At, raw.Facts[1].Fact));
                    Refused("a column's facts", raw => raw.Facts![0] = (child, raw.Facts[0].Fact));
                    Refused("a description of no column", raw => raw.Descriptions[0] = (top, raw.Descriptions[0].Text));
                    Refused("a description of no entry", raw => raw.Descriptions[^1] = (-1, raw.Descriptions[^1].Text));
                    Refused("a shard group of a column", raw => raw.Shards[0] = (child, raw.Shards[0].Group));
                    Refused("a fact with unknown flags", raw => raw.FactFlags = 0x800);
                    Refused("a shard group of fewer than none", raw => raw.Shards[0] = (raw.Shards[0].At, raw.Shards[0].Group with { Count = -1 }));
                    Refused("a fact longer than the format allows", raw => raw.Facts![0] = (raw.Facts[0].At, raw.Facts[0].Fact with { Signature = new string('s', IndexFileLimits.FactChars + 1) }), IndexFileProblem.Limits);
                }
                // A BigQuery read holds no text that nothing names.
                if (kind == IndexUnitKind.Dataset) Refused("a text nothing names", raw => raw.Texts.Add("unnamed"));
                // Texts no entry names are still texts the load holds: each is charged its slot, however many the file states.
                if (kind == IndexUnitKind.Database)
                {
                    cases++;
                    var raw = Raw.Of(unit);
                    for (var extra = 0; extra < 20_000; extra++) raw.Texts.Add("unnamed");
                    raw.Retag();
                    raw.Sort();
                    var before = world.Budget.Used;
                    var loaded = Load(world, Forge(header with { MemoryBytes = raw.Whole }, raw.Write(), protection), kind, protection);
                    if (loaded.Value is not { } many || many.Table.Texts.Count != raw.Texts.Count || many.Pooled.Length != raw.Texts.Count || many.Bytes != raw.Whole
                        || world.Budget.Used - before < 20_000 * IndexMemory.SlotBytes) failures.Add($"{kind} 20,000 texts no entry names: {loaded.Problem}, {world.Budget.Used - before} bytes charged");
                    if (loaded.Value is not null) world.Connection.Abandon(loaded.Value);
                    if (!world.Empty) failures.Add($"{kind} 20,000 texts no entry names left {world.Budget.Used} bytes");
                }
                // A million texts no entry names, in a file large enough to hold them (a few hundred KiB, packed): the load holds
                // only what it is charged for, so a budget too small for their places refuses them before it holds them.
                if (kind == IndexUnitKind.Database)
                {
                    cases++;
                    var raw = Raw.Of(unit);
                    for (var extra = 0; extra < 1_000_000; extra++) raw.Texts.Add("");
                    raw.Retag();
                    raw.Sort();
                    var file = Forge(header with { MemoryBytes = raw.Whole }, raw.Write(), protection);
                    var small = new World(new ObjectIndexLimits { DefinitionChars = 2000, MemoryBytes = 1 << 20, NamesReserveBytes = 0 });
                    var before = GC.GetAllocatedBytesForCurrentThread();
                    var refused = Load(small, file, kind, protection);
                    var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
                    var loaded = Load(world, file, kind, protection);
                    if (file.Length > 1 << 20 || refused.Problem != IndexFileProblem.Budget || !small.Empty || allocated > 24 << 20 || loaded.Value is not { } many || many.Bytes != raw.Whole
                        || world.Budget.Used < 1_000_000 * IndexMemory.SlotBytes)
                        failures.Add($"{kind} a million texts no entry names in a {file.Length} byte file: {refused.Problem} with {allocated} bytes allocated under a 1 MiB budget, {loaded.Problem} under a roomy one");
                    if (loaded.Value is not null) world.Connection.Abandon(loaded.Value);
                    if (!world.Empty) failures.Add($"{kind} a million texts left {world.Budget.Used} bytes");
                }
                Refused("extra bytes past the format's limit", raw => raw.Extra = new byte[IndexFileLimits.ExtraBytes + 1], IndexFileProblem.Limits);
                // Content that ends early, or goes on, inside chunks that are whole.
                var content = Raw.Of(unit).Write();
                foreach (var (what, bytes) in new[] { ("content that ends early", content[..^1]), ("content cut in half", content[..(content.Length / 2)]), ("no content", Array.Empty<byte>()), ("content that goes on", [.. content, 0]) })
                {
                    cases++;
                    var loaded = Load(world, Forge(header, bytes, protection), kind, protection);
                    if (loaded.Problem != IndexFileProblem.Corrupt || !world.Empty) failures.Add($"{kind} {what}: {loaded.Problem}");
                }
                // Counts no file of this size could back: refused before anything is allocated by them.
                foreach (var what in new[] { "long definitions", "texts", "entries" })
                {
                    cases++;
                    var raw = Raw.Of(unit);
                    var bytes = raw.Write();
                    // The texts' counts are their own strings, their strings, their own long definitions and their total.
                    var at = what == "entries" ? raw.EntryCountAt : raw.TextCountsAt + 12;
                    if (what == "texts") BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(raw.TextCountsAt + 4), IndexFileLimits.Texts / 2);
                    foreach (var value in new[] { int.MaxValue, IndexFileLimits.Texts, -1, 1 << 30 })
                    {
                        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(at), value);
                        var before = GC.GetAllocatedBytesForCurrentThread();
                        var loaded = Load(world, Forge(header, bytes, protection), kind, protection);
                        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
                        if (loaded.Problem is not (IndexFileProblem.Limits or IndexFileProblem.Budget or IndexFileProblem.Corrupt) || !world.Empty || allocated > 64 << 20)
                            failures.Add($"{kind} a count of {value} {what}: {loaded.Problem}, {allocated} bytes allocated");
                    }
                }
            }
            check(failures.Count == 0 && cases > 100, $"content that breaks a rule is refused by its own checks inside a file sealed as a writer seals one ({mode}, {cases} cases): {string.Join("; ", failures.Take(6))}");
        }
        source.Connection.Abandon(database);
        source.Connection.Abandon(dataset);
    }

    /// <summary>A long definition with its frame changed, keeping the lengths it states.</summary>
    private static PackedText Frame(PackedText text, Action<byte[]> change)
    {
        var frame = text.Frame.ToArray();
        change(frame);
        return new ForgedFrame(frame, text.Length, text.ByteLength).Text;
    }

    /// <summary>A packed text around bytes that may be no frame at all: only the checks make one, to write it into a file.</summary>
    private sealed class ForgedFrame(byte[] frame, int length, int byteLength)
    {
        public PackedText Text { get; } = (PackedText)typeof(PackedText).GetConstructor(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance, [typeof(byte[]), typeof(int), typeof(int)])!
            .Invoke([frame, length, byteLength]);
    }

    // ---- Chunks ----

    /// <summary>A file of several chunks: each is bound to its place, to being the last or not, and to its own file's header.</summary>
    private static async Task Chunks(Action<bool, string> check)
    {
        var source = new World(new ObjectIndexLimits());
        // Definitions no compressor shrinks much, so the body runs to several chunks.
        var random = new Random(11);
        var rows = Enumerable.Range(0, 80).Select(at => new IndexedObject("procedure", "storedProcedures", "dbo", "usp_" + at,
            Definition: string.Concat(Enumerable.Range(0, 8000).Select(_ => (char)random.Next(0x4E00, 0x9FFF))))).ToArray();
        var unit = new DatabaseIndex("Big", rows, 80 * IndexMemory.RecordBytes + ObjectTable.Of(rows).Texts.Count * IndexMemory.SlotBytes, 80, 0);
        foreach (var (mode, protection) in Modes)
        {
            var file = Save(unit, IndexUnitKind.Database, protection);
            var twin = Save(unit, IndexUnitKind.Database, protection);
            var world = new World(new ObjectIndexLimits());
            IndexFileProblem Problem(byte[] bytes)
            {
                var loaded = Load(world, bytes, IndexUnitKind.Database, protection);
                if (loaded.Value is not null) world.Connection.Abandon(loaded.Value);
                return world.Empty ? loaded.Problem : IndexFileProblem.None;
            }
            // The chunks, by where each starts and ends in the file.
            var chunks = new List<(int From, int To)>();
            var bodyAt = (int)Header(file, protection).Identity.Length + Sync.Length + IndexFileContainer.PrefixBytes + IndexFileContainer.FixedHeaderBytes + (protection.IsEncrypted ? 16 : 32);
            for (var at = bodyAt; at < file.Length;)
            {
                var size = (int)BinaryPrimitives.ReadUInt32LittleEndian(file.AsSpan(at));
                chunks.Add((at, at + 5 + size + 16));
                at += 5 + size + 16;
            }
            byte[] Of(params (byte[] File, int Chunk)[] order) => [.. file[..bodyAt], .. order.SelectMany(item => item.File[chunks[item.Chunk].From..chunks[item.Chunk].To])];
            var last = chunks.Count - 1;
            var whole = Enumerable.Range(0, chunks.Count).Select(at => (file, at)).ToArray();
            check(chunks.Count >= 3 && Problem(Of(whole)) == IndexFileProblem.None && file[chunks[last].From + 4] == 1 && file[chunks[0].From + 4] == 0
                && chunks.Take(last).All(chunk => chunk.To - chunk.From == 5 + IndexFileContainer.ChunkBytes + 16),
                $"a large unit's body is {chunks.Count} chunks, every one full but the last, which says it is the last ({mode})");
            var swapped = (byte[])file.Clone();
            file.AsSpan(chunks[1].From, chunks[1].To - chunks[1].From).CopyTo(swapped.AsSpan(chunks[0].From));
            file.AsSpan(chunks[0].From, chunks[0].To - chunks[0].From).CopyTo(swapped.AsSpan(chunks[1].From));
            check(Problem(swapped) == IndexFileProblem.Corrupt, $"two chunks in each other's place are refused ({mode})");
            check(Problem(Of([.. whole.Skip(1)])) == IndexFileProblem.Corrupt && Problem(Of([.. whole.Take(1), .. whole.Skip(2)])) == IndexFileProblem.Corrupt, $"a file missing a chunk at its start or in its middle is refused ({mode})");
            check(Problem(Of([.. whole.Take(last)])) == IndexFileProblem.Truncated && Problem(file[..chunks[last].From]) == IndexFileProblem.Truncated && Problem(file[..(chunks[1].From + 3)]) == IndexFileProblem.Truncated,
                $"a file cut at a chunk's edge, where every chunk left is whole and sound, is still truncated: its last chunk is missing ({mode})");
            check(Problem(Of([.. whole.Take(2), .. whole.Skip(1)])) == IndexFileProblem.Corrupt, $"a chunk repeated is refused ({mode})");
            check(Problem(Of([(twin, 0), .. whole.Skip(1)])) == IndexFileProblem.Corrupt && Problem(Of([.. whole.Take(last), (twin, last)])) == IndexFileProblem.Corrupt
                && Problem([.. twin[..bodyAt], .. file[bodyAt..]]) == IndexFileProblem.Corrupt,
                $"a chunk from another file of the same unit under the same key, or another file's header, is refused: each file's chunks are its own ({mode})");
            // The last chunk passed off as not the last (with more after it), and an inner chunk as the last.
            var notLast = Of([.. whole, (file, last)]);
            notLast[chunks[last].From + 4] = 0;
            var early = Of([.. whole.Take(2)]);
            early[chunks[1].From + 4] = 1;
            check(Problem(notLast) == IndexFileProblem.Corrupt && Problem(early) == IndexFileProblem.Corrupt, $"a chunk's place includes whether it is the last: neither can be passed off as the other ({mode})");
            var longer = (byte[])file.Clone();
            BinaryPrimitives.WriteUInt32LittleEndian(longer.AsSpan(chunks[0].From), IndexFileContainer.ChunkBytes + 1);
            var huge = (byte[])file.Clone();
            BinaryPrimitives.WriteUInt32LittleEndian(huge.AsSpan(chunks[0].From), uint.MaxValue);
            var shorter = (byte[])file.Clone();
            BinaryPrimitives.WriteUInt32LittleEndian(shorter.AsSpan(chunks[0].From), IndexFileContainer.ChunkBytes - 1);
            var before = GC.GetAllocatedBytesForCurrentThread();
            var refused = Problem(longer) == IndexFileProblem.Corrupt && Problem(huge) == IndexFileProblem.Corrupt && Problem(shorter) == IndexFileProblem.Corrupt;
            check(refused && GC.GetAllocatedBytesForCurrentThread() - before < 16 << 20, $"a chunk that states another length than the fixed one is refused before anything is read or allocated by it ({mode})");
        }
        source.Connection.Abandon(unit);

        // Blocks: a length a block states is checked against the fixed block size, and against what it unpacks to.
        {
            var world = new World();
            var small = await Database(world);
            var header = Header(Save(small, IndexUnitKind.Database, Clear), Clear);
            var content = Payload(Save(small, IndexUnitKind.Database, Clear), Clear);
            byte[] Blocks(Action<MemoryStream> write)
            {
                using var stream = new MemoryStream();
                var (seal, _) = IndexFileContainer.WriteHeader(stream, header, Clear.Key);
                using var sealing = seal;
                var chunks = new IndexFileContainer.ChunkWriter(stream, seal, 0, default);
                var body = new MemoryStream();
                write(body);
                chunks.Write(body.ToArray());
                chunks.Finish();
                return stream.ToArray();
            }
            static void Block(MemoryStream body, byte codec, uint raw, byte[] bytes, uint? stored = null, bool padded = true)
            {
                Span<byte> head = stackalloc byte[9];
                head[0] = codec;
                BinaryPrimitives.WriteUInt32LittleEndian(head[1..], raw);
                BinaryPrimitives.WriteUInt32LittleEndian(head[5..], stored ?? (uint)bytes.Length);
                body.Write(head[..(codec == 0 ? 5 : 9)]);
                body.Write(bytes);
                if (codec == 1 && padded && raw <= IndexFileContainer.BlockBytes) body.Write(new byte[Padding((int)raw, (int)(stored ?? (uint)bytes.Length))]);
            }
            var packed = new byte[content.Length + 1024];
            ZstandardEncoder.TryCompress(content, packed, out var size, 3, 0);
            packed = packed[..size];
            IndexFileProblem Problem(byte[] bytes)
            {
                var loaded = Load(world, bytes, IndexUnitKind.Database, Clear);
                if (loaded.Value is not null) world.Connection.Abandon(loaded.Value);
                return loaded.Problem;
            }
            var before = world.Budget.Used;
            // A bomb: 64 KiB of zeros unpack to a mebibyte, and a block that says it unpacks to more than a block is refused unread.
            var zeros = new byte[2 << 20];
            var bomb = new byte[4096];
            ZstandardEncoder.TryCompress(zeros, bomb, out var bombSize, 3, 0);
            check(Problem(Blocks(body => Block(body, 0, (uint)content.Length, content))) == IndexFileProblem.None && Problem(Blocks(body => Block(body, 1, (uint)content.Length, packed))) == IndexFileProblem.None
                && Problem(Blocks(body => { Block(body, 0, 100, content[..100]); Block(body, 1, (uint)(content.Length - 100), Zstd(content[100..])); })) == IndexFileProblem.None,
                "content loads from stored blocks, compressed blocks, or both");
            check(Problem(Blocks(body => Block(body, 1, (uint)content.Length + 1, packed))) == IndexFileProblem.Corrupt && Problem(Blocks(body => Block(body, 1, (uint)content.Length - 1, packed))) == IndexFileProblem.Corrupt
                && Problem(Blocks(body => Block(body, 2, (uint)content.Length, content))) == IndexFileProblem.Corrupt && Problem(Blocks(body => Block(body, 0, 0, []))) == IndexFileProblem.Corrupt
                && Problem(Blocks(body => Block(body, 1, (uint)content.Length, packed, stored: 0))) == IndexFileProblem.Corrupt
                && Problem(Blocks(body => Block(body, 1, (uint)zeros.Length, bomb[..bombSize]))) == IndexFileProblem.Corrupt
                && Problem(Blocks(body => Block(body, 1, IndexFileContainer.BlockBytes, bomb[..bombSize]))) == IndexFileProblem.Corrupt
                && Problem(Blocks(body => Block(body, 0, uint.MaxValue, content))) == IndexFileProblem.Corrupt
                && Problem(Blocks(body => Block(body, 1, 16, content[..64]))) == IndexFileProblem.Corrupt,
                "a block that states the wrong size, an unknown codec, no bytes, more than a block, or that is not smaller compressed, is refused; a block never unpacks past the fixed block size");
            check(world.Budget.Used == before, "and none of them leaves anything charged");

            // A block may not unpack to more than 64 times what it takes in the file: one that packs better is padded to that,
            // so a megabyte of file never yields more than 64 of content, and a count the file is too small to back is
            // refused before anything is allocated by it.
            var flat = new byte[3 << 20];
            var padded = Save(small, IndexUnitKind.Database, Clear, extra: flat);
            var unpadded = Save(small, IndexUnitKind.Database, Clear);
            var loaded = Load(world, padded, IndexUnitKind.Database, Clear);
            check(loaded.Value is not null && loaded.Extra!.AsSpan().SequenceEqual(flat) && padded.Length - unpadded.Length is var grown && grown >= flat.Length / IndexFileContainer.MaxRatio
                && grown < flat.Length / IndexFileContainer.MaxRatio + 4096 && Payload(padded, Clear).Length <= (long)IndexFileContainer.MaxRatio * padded.Length,
                $"three megabytes of one repeated byte take a sixty-fourth of their size in the file, and load back ({padded.Length - unpadded.Length} bytes)");
            if (loaded.Value is not null) world.Connection.Abandon(loaded.Value);
            var zeroBlock = Zstd(new byte[IndexFileContainer.BlockBytes]);
            var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            check(Problem(Blocks(body => { for (var block = 0; block < 64; block++) Block(body, 1, IndexFileContainer.BlockBytes, zeroBlock, padded: false); })) == IndexFileProblem.Corrupt
                && GC.GetAllocatedBytesForCurrentThread() - allocatedBefore < 32 << 20,
                "blocks that pack better than the ratio without their padding are refused");
            check(world.Budget.Used == before, "and leave nothing charged");

            // A long definition's frame is under the same rule: one that packs better than 64 to one is padded to that, so
            // unpacking and checking definitions never costs more than 64 times the file.
            var flatRows = new[] { new IndexedObject("procedure", "storedProcedures", "dbo", "usp_flat", Definition: new string('a', 200_000)) };
            var flat1 = new DatabaseIndex("Flat", flatRows, IndexMemory.RecordBytes + 3 * IndexMemory.SlotBytes, 1, 0);
            var flatFile = Save(flat1, IndexUnitKind.Database, Clear);
            var flatLoaded = Load(world, flatFile, IndexUnitKind.Database, Clear);
            var frame = (PackedText)flat1.Table.StoredDefinition(0)!;
            var unpaddedRaw = Raw.Of(flat1);
            unpaddedRaw.NoFramePadding = true;
            check(frame.FrameLength < 200 && flatFile.Length > 200_000 / IndexFileContainer.MaxRatio && flatFile.Length < 200_000 / IndexFileContainer.MaxRatio + 1024
                && flatLoaded.Value is { } flatBack && Dump(flatBack.Table) == Dump(flat1.Table)
                && Problem(Forge(Header(flatFile, Clear), Raw.Of(flat1).Write(), Clear)) == IndexFileProblem.None
                && Problem(Forge(Header(flatFile, Clear), unpaddedRaw.Write(), Clear)) == IndexFileProblem.Corrupt,
                $"a definition of one repeated letter ({frame.FrameLength} bytes packed) takes a sixty-fourth of its length in the file ({flatFile.Length} bytes), and one without that padding is refused");
            if (flatLoaded.Value is not null) world.Connection.Abandon(flatLoaded.Value);
            world.Connection.Abandon(small);
        }
    }

    private static byte[] Zstd(byte[] bytes)
    {
        var room = new byte[bytes.Length + 1024];
        ZstandardEncoder.TryCompress(bytes, room, out var size, 3, 0);
        return room[..size];
    }

    // ---- Fuzz ----

    /// <summary>
    /// A seeded fuzz pass over both modes. File bytes flipped, cut, spliced and moved are always refused (each tag covers its
    /// chunk's place and file). Content changed the same ways and then sealed correctly is refused or loads: when it loads, the
    /// unit is walked by every reader (each entry through every accessor, definitions unpacked, the lookup arrays built,
    /// searches, lookups, what BigQuery reuses, the memory report) and then dropped, and nothing may throw or stay charged.
    /// </summary>
    private static async Task Fuzz(Action<bool, string> check)
    {
        var source = new World();
        var set = await source.Catalog.AcquireAsync(ResourceKey, _ => ResourceObjects(source));
        (string Name, IndexUnitKind Kind, DatabaseIndex? Unit)[] units =
        [
            ("database", IndexUnitKind.Database, await Database(source)), ("dataset", IndexUnitKind.Dataset, Dataset(source, DatasetEntries())), ("server", IndexUnitKind.Server, await Server(source)),
            ("bulk dataset", IndexUnitKind.Dataset, Dataset(source, BulkEntries())), ("resource", IndexUnitKind.Resource, null)
        ];
        var random = new Random(20261126);
        var failures = new List<string>();
        int files = 0, contents = 0, loaded = 0;
        var reasons = new Dictionary<IndexFileProblem, int>();
        foreach (var (mode, protection) in Modes)
        {
            var saved = units.Select(unit =>
            {
                if (unit.Unit is not null) return Save(unit.Unit, unit.Kind, protection);
                using var stream = new MemoryStream();
                IndexFile.SaveResource(stream, set, DateTime.UtcNow, new IndexSaveOptions(protection, Identity, Sync));
                return stream.ToArray();
            }).ToArray();
            var payloads = saved.Select(file => Payload(file, protection)).ToArray();
            var headers = saved.Select(file => Header(file, protection)).ToArray();
            for (var which = 0; which < units.Length; which++)
            {
                var (name, kind, _) = units[which];
                // Loads the bytes into a world of their own; answers the reason, and whether the unit loaded and was walked.
                (IndexFileProblem Problem, bool Loaded) Run(byte[] bytes, bool children)
                {
                    var world = new World();
                    var problem = IndexFileProblem.None;
                    var held = false;
                    if (kind == IndexUnitKind.Resource)
                    {
                        using var stream = new MemoryStream(bytes, writable: false);
                        var answer = IndexFile.LoadResource(stream, protection, Identity, 1L << 30);
                        problem = answer.Problem;
                        if (answer.Value is { } value)
                        {
                            held = true;
                            world.Connection.PutResource(world.Catalog.AcquireSavedAsync(value.Key, _ => Task.FromResult(value.Read)).GetAwaiter().GetResult());
                            world.Connection.Put(new DatabaseIndex("master", [], 0, 0, 0));
                        }
                    }
                    else
                    {
                        var answer = Load(world, bytes, kind, protection, children: children);
                        problem = answer.Problem;
                        if (answer.Value is { } value)
                        {
                            held = true;
                            world.Hold(value, kind);
                        }
                    }
                    if (held) Walk(world);
                    world.Connection.Dispose();
                    if (!world.Empty) throw new InvalidOperationException($"{world.Budget.Used} bytes and {world.Pool.Count} texts stayed charged");
                    return (problem, held);
                }
                void Case(string what, int seed, byte[] bytes, bool mustRefuse)
                {
                    try
                    {
                        var (problem, held) = Run(bytes, children: seed % 5 != 0);
                        reasons[problem] = reasons.GetValueOrDefault(problem) + 1;
                        if (held) loaded++;
                        if (held && mustRefuse) failures.Add($"{name} {what} #{seed} ({mode}) loaded");
                        if (!held && problem == IndexFileProblem.None) failures.Add($"{name} {what} #{seed} ({mode}) answered nothing");
                    }
                    catch (Exception error)
                    {
                        failures.Add($"{name} {what} #{seed} ({mode}) threw {error.GetType().Name}: {error.Message}");
                    }
                }
                byte[] Mutate(byte[] original, byte[][] others)
                {
                    var bytes = (byte[])original.Clone();
                    for (var changes = random.Next(1, 4); changes > 0 && bytes.Length > 8; changes--)
                    {
                        var at = random.Next(bytes.Length);
                        switch (random.Next(9))
                        {
                            case 0: bytes[at] ^= (byte)(1 << random.Next(8)); break;
                            case 1: bytes[at] = (byte)random.Next(256); break;
                            case 2:
                                int[] values = [-1, 0, 1, int.MaxValue, int.MinValue, 65535, 65536, bytes.Length, 1 << 24, -2, 255];
                                if (at + 4 <= bytes.Length) BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(at), values[random.Next(values.Length)]);
                                break;
                            case 3: bytes = bytes[..at]; break;
                            case 4:
                                var gone = Math.Min(random.Next(1, 17), bytes.Length - at);
                                bytes = [.. bytes[..at], .. bytes[(at + gone)..]];
                                break;
                            case 5:
                                var again = Math.Min(random.Next(1, 33), bytes.Length - at);
                                bytes = [.. bytes[..(at + again)], .. bytes[at..]];
                                break;
                            case 6:
                                var from = others[random.Next(others.Length)];
                                var size = Math.Min(Math.Min(random.Next(1, 257), bytes.Length - at), from.Length);
                                from.AsSpan(random.Next(from.Length - size + 1), size).CopyTo(bytes.AsSpan(at));
                                break;
                            case 7:
                                if (at + 2 <= bytes.Length) (bytes[at], bytes[at + 1]) = (0xFF, 0xFF);
                                break;
                            default:
                                var to = random.Next(bytes.Length);
                                var span = Math.Min(random.Next(1, 65), bytes.Length - Math.Max(at, to));
                                var moved = bytes.AsSpan(at, span).ToArray();
                                bytes.AsSpan(to, span).CopyTo(bytes.AsSpan(at));
                                moved.CopyTo(bytes.AsSpan(to));
                                break;
                        }
                    }
                    return bytes;
                }
                // The file's own bytes changed: no tag holds, so nothing loads. (A change may be none: two equal ranges swapped.)
                for (var seed = 0; seed < 400; seed++)
                {
                    var bytes = Mutate(saved[which], saved);
                    if (bytes.AsSpan().SequenceEqual(saved[which])) continue;
                    files++;
                    Case("file", seed, bytes, mustRefuse: true);
                }
                // The content changed and sealed again as a writer seals it.
                for (var seed = 0; seed < 1100; seed++)
                {
                    contents++;
                    var header = headers[which];
                    // Now and then the header's own counts are wrong too.
                    if (seed % 7 == 0) header = header with { Objects = random.Next(3) == 0 ? random.Next(100) : header.Objects, MemoryBytes = random.Next(3) == 0 ? random.NextInt64(1 << 20) : header.MemoryBytes };
                    Case("content", seed, Forge(header, Mutate(payloads[which], payloads), protection), mustRefuse: false);
                }
            }
        }
        check(failures.Count == 0 && files > 3000 && contents > 10000 && loaded > 200 && reasons.GetValueOrDefault(IndexFileProblem.Corrupt) > 1000,
            $"{files:N0} files with their bytes changed are all refused, and {contents:N0} contents changed and sealed correctly are refused or load to a unit every reader walks ({loaded:N0} loaded; "
            + string.Join(", ", reasons.OrderBy(pair => pair.Key).Select(pair => pair.Key + " " + pair.Value)) + "): " + string.Join("; ", failures.Take(5)));
        foreach (var unit in units)
            if (unit.Unit is not null) source.Connection.Abandon(unit.Unit);
        source.Catalog.Release(set);
        check(source.Empty, "the fuzz pass leaves its own units' budget and pool empty");
    }

    /// <summary>Every reader over everything a world holds, as the fuzz pass's proof that a loaded unit keeps the rules they rely
    /// on: each throws on a table that does not.</summary>
    private static void Walk(World world)
    {
        foreach (var unit in world.Connection.Held)
        {
            Dump(unit);
            var table = unit.Table;
            var lookup = TableLookup.Build(table);
            for (var at = 0; at < table.Count; at++)
            {
                if (table.Label(at).Length != table.LabelLength(at)) throw new InvalidOperationException("A label's length is not its label's.");
                foreach (var child in lookup.Children(at))
                    if (table.Parent(child) != at) throw new InvalidOperationException("A child is not its parent's.");
                foreach (var named in lookup.Named(table.Name(at))) _ = table.Kind(named);
                foreach (var key in lookup.Referencing(at))
                    if (table.Parent(key) < 0) throw new InvalidOperationException("A foreign key has no table.");
            }
        }
        if (world.Connection.Resource is { } set) Dump(set.Table);
        foreach (var (text, names, definitions, fuzzy) in new[] { ("e", true, false, false), ("select", false, true, false), ("ordres", true, false, true), ("a.b", true, true, false) })
        {
            var query = new SearchQuery(text, false, false, false, names, definitions, null, null, 50, fuzzy);
            IndexSearch.Run(world.Connection, query, SearchMatcher.Create(text, false, false, false, world.Limits.MatchTimeout).Matcher!, world.Limits, Ready, CancellationToken.None);
        }
        Lookups(world);
        BigQueryLookups(world);
        _ = world.Memory;
    }

    // ---- Writing a file in place of another ----

    private static async Task Atomic(Action<bool, string> check)
    {
        var world = new World();
        var first = await Database(world);
        var second = await Database(world, extraTables: 30);
        var folder = Directory.CreateTempSubdirectory("varia-index-checks-");
        try
        {
            var path = Path.Combine(folder.FullName, "unit.vidx");
            var options = new IndexSaveOptions(Sealed, Identity);
            string[] Files() => [.. Directory.GetFiles(folder.FullName).Select(Path.GetFileName).Order()!];
            string? Held()
            {
                var loaded = IndexFile.LoadFile(path, new IndexLoadOptions(Sealed, IndexUnitKind.Database, Identity), world.Limits, world.Pool);
                if (loaded.Value is null) return loaded.Problem.ToString();
                var dump = Dump(loaded.Value);
                world.Connection.Abandon(loaded.Value);
                return dump;
            }
            check(IndexFile.SaveFile(path, first, IndexUnitKind.Database, options) == IndexFileProblem.None && Files() is ["unit.vidx"] && Held() == Dump(first)
                && IndexFile.ReadHeaderFile(path, Sealed).Value is { Kind: IndexUnitKind.Database },
                "a unit saved to a path is there, whole, with no temporary file beside it");
            var bytes = File.ReadAllBytes(path);
            bool Unchanged() => File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes) && Files() is ["unit.vidx"];

            using (var stopped = new CancellationTokenSource())
            {
                stopped.Cancel();
                check(IndexFile.SaveFile(path, second, IndexUnitKind.Database, options, stopped.Token) == IndexFileProblem.Cancelled && Unchanged(), "a save stopped before it starts leaves the earlier file and no temporary file");
            }
            // Stopped and failing part way: the temporary file holds part of a unit when the write ends.
            var sawTemporary = false;
            var midway = IndexFile.Replace(path, stream =>
            {
                stream.Write(bytes, 0, bytes.Length / 2);
                stream.Flush();
                sawTemporary = Files() is ["unit.vidx", var temporary] && temporary.StartsWith("unit.vidx.", StringComparison.Ordinal) && temporary.EndsWith(IndexFile.TemporaryExtension, StringComparison.Ordinal);
                return IndexFileProblem.Cancelled;
            }, default);
            check(midway == IndexFileProblem.Cancelled && sawTemporary && Unchanged(), "a save stopped part way was writing a temporary file beside its target, and leaves the earlier file and no temporary file");
            var failed = IndexFile.Replace(path, stream =>
            {
                stream.Write(bytes, 0, bytes.Length / 3);
                throw new IOException("The disk is full.");
            }, default);
            check(failed == IndexFileProblem.Io && Unchanged(), "a save that fails part way leaves the earlier file and no temporary file");
            using (var late = new CancellationTokenSource())
            {
                var stoppedLate = IndexFile.Replace(path, stream =>
                {
                    stream.Write(bytes);
                    late.Cancel();
                    return IndexFileProblem.None;
                }, late.Token);
                check(stoppedLate == IndexFileProblem.Cancelled && Unchanged(), "a save stopped after its last byte, before the rename, leaves the earlier file");
            }
            // A stream that stops the save's token as it writes: the save answers that, as a value.
            using (var during = new CancellationTokenSource())
            using (var stream = new Stopping(during, afterWrites: 0))
                check(IndexFile.Save(stream, second, IndexUnitKind.Database, options, during.Token) == IndexFileProblem.Cancelled, "a save stopped while it writes answers that");
            using (var stream = new Stopping(null, afterWrites: 1))
                check(IndexFile.Save(stream, second, IndexUnitKind.Database, options) == IndexFileProblem.Io, "a save whose stream fails answers an I/O problem");

            check(IndexFile.SaveFile(Path.Combine(folder.FullName, "missing", "unit.vidx"), first, IndexUnitKind.Database, options) == IndexFileProblem.Io && Unchanged(), "a save into a folder that is not there is an I/O problem");
            Directory.CreateDirectory(Path.Combine(folder.FullName, "taken"));
            check(IndexFile.SaveFile(Path.Combine(folder.FullName, "taken"), first, IndexUnitKind.Database, options) == IndexFileProblem.Io && Directory.GetFiles(folder.FullName) is [var only] && only == path,
                "a save over something that cannot be replaced is an I/O problem and leaves no temporary file");
            Directory.Delete(Path.Combine(folder.FullName, "taken"));

            // A reader holds the earlier file open while a save replaces it: the save succeeds, the reader still reads the file it opened.
            using (var reading = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete))
            {
                var replaced = IndexFile.SaveFile(path, second, IndexUnitKind.Database, options);
                var earlier = IndexFile.Load(reading, new IndexLoadOptions(Sealed, IndexUnitKind.Database, Identity), world.Limits, world.Pool);
                check(replaced == IndexFileProblem.None && earlier.Value is not null && Dump(earlier.Value) == Dump(first),
                    $"a save replaces a file a load has open, and that load still reads the file it opened: {replaced}, {earlier.Problem}");
                if (earlier.Value is not null) world.Connection.Abandon(earlier.Value);
            }
            check(Files() is ["unit.vidx"] && Held() == Dump(second), "the replaced file is the newer unit, whole, with no temporary file beside it");
            // A temporary file a crash left is not a unit's file, and is not one a load would take for one.
            File.WriteAllBytes(path + ".0123456789abcdef" + IndexFile.TemporaryExtension, bytes[..(bytes.Length / 2)]);
            check(IndexFile.LoadFile(path + ".0123456789abcdef" + IndexFile.TemporaryExtension, new IndexLoadOptions(Sealed, IndexUnitKind.Database, Identity), world.Limits, world.Pool).Problem == IndexFileProblem.Truncated
                && Held() == Dump(second), "a temporary file a crash left behind is truncated to a load, and does not disturb the unit's file");
        }
        finally { folder.Delete(true); }
        world.Connection.Abandon(first);
        world.Connection.Abandon(second);
        check(world.Empty, "the saves and loads by path leave nothing charged");
    }

    /// <summary>A stream whose writes stop a token, or fail, after some of them.</summary>
    private sealed class Stopping(CancellationTokenSource? stop, int afterWrites) : Stream
    {
        private int writes;
        private long written;

        public override void Write(byte[] buffer, int offset, int count)
        {
            if (++writes > afterWrites)
            {
                if (stop is null) throw new IOException("The disk failed.");
                stop.Cancel();
            }
            written += count;
        }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => written;
        public override long Position { get => written; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }

    // ---- The committed files ----

    public const string GoldensArgument = "--write-index-goldens";
    private static readonly string[] GoldenUnits = ["database", "dataset", "resource"];
    private static readonly DateTime GoldenReadAt = new(2026, 11, 26, 12, 0, 0, DateTimeKind.Utc);
    private static string GoldenFolder => Path.Combine(AppContext.BaseDirectory, "Fixtures", "IndexFile");

    private static async Task<(byte[] File, string Dump)> GoldenUnit(string unit, IndexFileProtection protection)
    {
        var world = new World();
        var options = new IndexSaveOptions(protection, Identity, Sync, new byte[] { 1, 2, 3 });
        using var stream = new MemoryStream();
        if (unit == "resource")
        {
            var set = await world.Catalog.AcquireAsync(ResourceKey, _ => ResourceObjects(world));
            IndexFile.SaveResource(stream, set, GoldenReadAt, options);
            return (stream.ToArray(), GoldenDump(set.Key, set.LeftOut, set.Table));
        }
        var read = unit == "database" ? await Database(world) : Dataset(world, DatasetEntries());
        IndexFile.Save(stream, read, unit == "database" ? IndexUnitKind.Database : IndexUnitKind.Dataset, options);
        return (stream.ToArray(), Dump(read, readAt: false));
    }

    private static string GoldenDump(ResourceKey key, int leftOut, ObjectTable table) => key + "|" + leftOut + "\n" + Dump(table);

    /// <summary>Writes the committed files of the current format version into <paramref name="folder"/> (the test project's
    /// Fixtures/IndexFile): run once when the format's version changes, never to make a failing check pass.</summary>
    public static async Task WriteGoldens(string folder)
    {
        Directory.CreateDirectory(folder);
        foreach (var unit in GoldenUnits)
        {
            string? dump = null;
            foreach (var (mode, protection) in Modes)
            {
                var (file, text) = await GoldenUnit(unit, protection);
                dump ??= text;
                File.WriteAllBytes(Path.Combine(folder, $"v{IndexFileContainer.Version}-{unit}-{(protection.IsEncrypted ? "encrypted" : "clear")}.vidx"), file);
            }
            File.WriteAllText(Path.Combine(folder, $"v{IndexFileContainer.Version}-{unit}.txt"), dump);
        }
    }

    /// <summary>The committed files, written once by the format version their names carry: the current version's must load to
    /// the content committed beside them, so a change to the format that keeps its version fails here; any other version's are
    /// refused as that, which is the rule a reader of this version is under when it meets a newer one.</summary>
    private static async Task Golden(Action<bool, string> check)
    {
        var files = Directory.Exists(GoldenFolder) ? Directory.GetFiles(GoldenFolder, "v*.vidx").Order(StringComparer.Ordinal).ToArray() : [];
        var current = 0;
        foreach (var path in files)
        {
            var parts = Path.GetFileNameWithoutExtension(path).Split('-');
            var version = int.Parse(parts[0][1..], System.Globalization.CultureInfo.InvariantCulture);
            var (unit, protection) = (parts[1], parts[2] == "encrypted" ? Sealed : Clear);
            var bytes = File.ReadAllBytes(path);
            var world = new World();
            string? loaded;
            IndexFileProblem problem;
            IndexFileHeader? header;
            if (unit == "resource")
            {
                using var stream = new MemoryStream(bytes, writable: false);
                var answer = IndexFile.LoadResource(stream, protection, Identity, long.MaxValue);
                (problem, header, loaded) = (answer.Problem, answer.Header, answer.Value is { } value ? GoldenDump(value.Key, value.Read.LeftOut, (await world.Catalog.AcquireSavedAsync(value.Key, _ => Task.FromResult(value.Read))).Table) : null);
            }
            else
            {
                var answer = Load(world, bytes, unit == "database" ? IndexUnitKind.Database : IndexUnitKind.Dataset, protection);
                (problem, header, loaded) = (answer.Problem, answer.Header, answer.Value is { } value ? Dump(value, readAt: false) : null);
            }
            if (version != IndexFileContainer.Version)
            {
                check(problem == IndexFileProblem.Version, $"{Path.GetFileName(path)}, written by format version {version}, is refused as another version's: {problem}");
                continue;
            }
            current++;
            var expected = File.ReadAllText(Path.Combine(GoldenFolder, $"v{version}-{unit}.txt")).ReplaceLineEndings("\n");
            check(problem == IndexFileProblem.None && loaded == expected && header is { Version: IndexFileContainer.Version } && header.ReadAt == (unit == "resource" ? GoldenReadAt : header.ReadAt)
                && header.Identity.AsSpan().SequenceEqual(Identity) && header.Sync.AsSpan().SequenceEqual(Sync),
                $"{Path.GetFileName(path)}, committed when format version {version} was set, still loads to the content committed beside it: {problem}" + (loaded is null ? "" : Difference(expected, loaded)));
            // What today's readers make of today's fixtures is what the file holds: the fixtures and the file have not drifted apart.
            var (_, fresh) = await GoldenUnit(unit, protection);
            check(fresh == expected, $"the checks' {unit} still reads to the content committed with format version {version}" + Difference(expected, fresh));
            // The same file with a newer (and an older) version's number is refused as that, whatever else it holds.
            var bumped = (byte[])bytes.Clone();
            BinaryPrimitives.WriteUInt16LittleEndian(bumped.AsSpan(8), (ushort)(version + 1));
            var older = (byte[])bytes.Clone();
            BinaryPrimitives.WriteUInt16LittleEndian(older.AsSpan(8), (ushort)(version - 1));
            using var newer = new MemoryStream(bumped, writable: false);
            using var earlier = new MemoryStream(older, writable: false);
            check(IndexFile.ReadHeader(newer, protection).Problem == IndexFileProblem.Version && IndexFile.ReadHeader(earlier, protection).Problem == IndexFileProblem.Version,
                $"{Path.GetFileName(path)} with the next or the previous format version's number is refused as that version's");
        }
        check(current == GoldenUnits.Length * Modes.Length && BinaryPrimitives.ReadUInt16LittleEndian(files.Length > 0 ? File.ReadAllBytes(files[^1]).AsSpan(8) : new byte[2]) is > 0,
            $"a file of every unit in both modes is committed for format version {IndexFileContainer.Version} ({current} of {GoldenUnits.Length * Modes.Length}): a new version commits its own, written by --write-index-goldens");
    }
}
