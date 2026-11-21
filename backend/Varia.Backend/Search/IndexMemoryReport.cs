namespace Varia.Backend.Search;

/// <summary>
/// What every connection's index holds, for the Memory panel's Nerd metrics (<see cref="IndexMemoryDetail"/>). It is read only
/// when an explorer.index.memory event goes out, never by a search or a build. Each held table is walked once (a shared resource
/// set once, however many connections show it); the pool's figures are its own counters. A table's definitions are the texts its
/// entries name as definitions and its packed texts (<see cref="ObjectTable.DefinitionTexts"/>), so a long definition a read pooled
/// for a row it then left out (a child whose parent the login cannot see) still counts as one, and that row's name stays a name.
/// Names are the held tables' other texts. A running read's records and the texts it has pooled are in no held table yet, so they
/// are what is left of the budget's use, shown as reading (a rebuild's records are charged against the table they replace, so only
/// growth beyond it shows); with no read running, records, names and definitions add up to it.
/// The used figure, when given, is the budget's use the event carries, so the parts add up to the figure sent beside them.
/// </summary>
internal static class IndexMemoryReport
{
    /// <summary>Each held table's split of its texts into definitions and names: tables never change, so a walk during a build
    /// works it out only for tables read since the last.</summary>
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<ObjectTable, bool[]> Kinds = [];

    public static IndexMemoryDetail Detail(IndexBudget budget, StringPool pool, IEnumerable<ConnectionIndex> connections, IEnumerable<ResourceSet> resources,
        long? lastBuildMs = null, long? lastSearchMs = null, long? used = null, HashSet<object>? reuse = null)
    {
        var budgetUsed = used ?? budget.Used;
        var (texts, references, _) = pool.Stats;
        var tables = new List<ObjectTable>();
        long recordBytes = 0, cut = 0;
        int holding = 0, childrenLeftOut = 0;
        foreach (var index in connections)
        {
            var held = index.Held;
            // A connection whose build failed before it read anything holds no index.
            if (held.Count > 0 || index.Resource is not null) holding++;
            foreach (var part in held)
            {
                tables.Add(part.Table);
                // Lookup arrays are part of the records: an entry's slot in them.
                recordBytes += part.Bytes + part.LookupBytes;
                cut += part.Cut;
                if (part.ChildrenLeftOut) childrenLeftOut++;
            }
        }
        foreach (var set in resources) { tables.Add(set.Table); recordBytes += set.Bytes; cut += set.Cut; }
        // Pooled tables share the pool's copy of a text, so one reference is one distinct text. A reused set keeps its arrays between
        // walks, rather than each walk allocating one the pool's size; it is emptied after the walk, so it holds no text alive.
        var seen = reuse ?? new HashSet<object>(texts, ReferenceEqualityComparer.Instance);
        try { return Walk(); }
        finally
        {
            if (reuse is not null)
            {
                reuse.Clear();
                if (reuse.EnsureCapacity(0) > 2L * texts + 1024) reuse.TrimExcess();
            }
        }

        IndexMemoryDetail Walk()
        {
        long objects = 0, definitions = 0, packedDefinitions = 0, definitionTexts = 0, packedTexts = 0, packedBytes = 0, packedTextBytes = 0, definitionBytes = 0, nameBytes = 0;
        var kinds = new List<bool[]>(tables.Count);
        foreach (var table in tables)
        {
            objects += table.Count;
            for (var at = 0; at < table.Count; at++)
            {
                if (table.StoredDefinition(at) is not { } stored) continue;
                definitions++;
                if (stored is PackedText) packedDefinitions++;
            }
            var defined = Kinds.GetValue(table, held => held.DefinitionTexts());
            kinds.Add(defined);
            for (var id = 0; id < defined.Length; id++)
            {
                if (!defined[id] || table.Texts[id] is not { } text || !seen.Add(text)) continue;
                definitionTexts++;
                definitionBytes += StringPool.Cost(text);
                if (text is not PackedText packed) continue;
                packedTexts++;
                packedBytes += packed.Bytes;
                packedTextBytes += IndexMemory.StringBytes(packed.Length);
            }
        }
        // Names after every definition, so a text one table holds as a definition and another as a name counts once, as a definition.
        for (var at = 0; at < tables.Count; at++)
        {
            var defined = kinds[at];
            var held = tables[at].Texts;
            for (var id = 0; id < defined.Length; id++)
                if (!defined[id] && held[id] is { } text && seen.Add(text)) nameBytes += StringPool.Cost(text);
        }
        // The figures are read one after another while reads may run, so reading is not allowed below zero.
        return new(holding, objects, texts, references, definitions, packedDefinitions, definitionTexts, packedTexts, packedBytes, packedTextBytes, cut, childrenLeftOut,
            recordBytes, nameBytes, definitionBytes, Math.Max(0, budgetUsed - recordBytes - nameBytes - definitionBytes), lastBuildMs, lastSearchMs);
        }
    }
}
