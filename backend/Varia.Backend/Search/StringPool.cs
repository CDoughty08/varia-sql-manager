namespace Varia.Backend.Search;

/// <summary>
/// The names and definitions every connection's index holds, each distinct text once, reference counted: a database read takes
/// one reference per distinct text it keeps and gives them back when its index is replaced or dropped, and a resource set one
/// per use. Servers whose msdb, master or model objects match (and every database's common column names, schemas and
/// definitions) so share one copy however many connections hold them. A text is charged to the budget once, with its entry,
/// when it first comes in, and given back with the last reference.
/// </summary>
internal sealed class StringPool(IndexBudget budget)
{
    /// <summary>A pool entry: the dictionary's slot and the entry object that counts references.</summary>
    public const long EntryBytes = 56;

    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);

    private sealed class Entry(string value)
    {
        public string Value { get; } = value;
        public int Refs;
    }

    public IndexBudget Budget => budget;
    /// <summary>Distinct texts held (the checks read it).</summary>
    public int Count { get { lock (gate) return entries.Count; } }

    /// <summary>What a text costs the budget while the pool holds it.</summary>
    public static long Cost(string value) => IndexMemory.StringBytes(value.Length) + EntryBytes;

    /// <summary>One reference to the pool's copy of <paramref name="value"/>. A text the pool does not hold yet is charged first:
    /// null when that would leave less than <paramref name="keepFree"/> free, unless <paramref name="force"/>.</summary>
    public string? TryAcquire(string value, long keepFree = 0, bool force = false)
    {
        lock (gate)
        {
            if (!entries.TryGetValue(value, out var entry))
            {
                var cost = Cost(value);
                if (force) budget.Force(cost);
                else if (!budget.TryTake(cost, keepFree)) return null;
                entry = new Entry(value);
                entries[value] = entry;
            }
            entry.Refs++;
            return entry.Value;
        }
    }

    /// <summary>Gives back one reference to each text; the last one drops the text and gives back its cost.</summary>
    public void Release(IEnumerable<string?> values)
    {
        lock (gate)
            foreach (var value in values)
            {
                if (value is null || !entries.TryGetValue(value, out var entry) || --entry.Refs > 0) continue;
                entries.Remove(value);
                budget.Release(Cost(value));
            }
    }
}
