namespace Varia.Backend.Search;

/// <summary>
/// What every connection's index holds, for the Memory panel's Nerd metrics (<see cref="IndexMemoryDetail"/>). It is read only
/// when an explorer.index.memory event goes out, never by a search or a build. Each held table is walked once (a shared resource
/// set once, however many connections show it); the pool's figures are its own counters. A table's definitions are the texts its
/// entries name as definitions and its packed texts (<see cref="ObjectTable.DefinitionTexts"/>), so a long definition a read pooled
/// for a row it then left out (a child whose parent the login cannot see) still counts as one, and that row's name stays a name.
/// Names are the pool's charges less those definitions, so texts a running read holds count as names and its records as reading;
/// with no read running, records, names and definitions add up to the budget's use.
/// </summary>
internal static class IndexMemoryReport
{
    public static IndexMemoryDetail Detail(IndexBudget budget, StringPool pool, IEnumerable<ConnectionIndex> connections, IEnumerable<ResourceSet> resources,
        long? lastBuildMs = null, long? lastSearchMs = null)
    {
        var used = budget.Used;
        var (texts, references, poolBytes) = pool.Stats;
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
                recordBytes += part.Bytes;
                cut += part.Cut;
                if (part.ChildrenLeftOut) childrenLeftOut++;
            }
        }
        foreach (var set in resources) { tables.Add(set.Table); recordBytes += set.Bytes; cut += set.Cut; }
        // Pooled tables share the pool's copy of a text, so one reference is one distinct text.
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        long objects = 0, definitions = 0, packedDefinitions = 0, definitionTexts = 0, packedTexts = 0, packedBytes = 0, packedTextBytes = 0, definitionBytes = 0;
        foreach (var table in tables)
        {
            objects += table.Count;
            for (var at = 0; at < table.Count; at++)
            {
                if (table.StoredDefinition(at) is not { } stored) continue;
                definitions++;
                if (stored is PackedText) packedDefinitions++;
            }
            var defined = table.DefinitionTexts();
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
        // The figures are read one after another while reads may run, so none is allowed below zero.
        return new(holding, objects, texts, references, definitions, packedDefinitions, definitionTexts, packedTexts, packedBytes, packedTextBytes, cut, childrenLeftOut,
            recordBytes, Math.Max(0, poolBytes - definitionBytes), Math.Min(definitionBytes, poolBytes), Math.Max(0, used - recordBytes - poolBytes), lastBuildMs, lastSearchMs);
    }
}
