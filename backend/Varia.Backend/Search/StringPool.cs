namespace Varia.Backend.Search;

/// <summary>
/// The names and definitions every connection's index holds, each distinct text once, reference counted: a database read takes
/// one reference per distinct text it keeps and gives them back when its index is replaced or dropped, and a resource set one
/// per use. Servers whose msdb, master or model objects match (and every database's common column names, schemas and
/// definitions) so share one copy however many connections hold them. A text is a string, or a long definition's
/// <see cref="PackedText"/> (equal by content, so packed definitions share one copy too). A text is charged to the budget once,
/// with its entry, when it first comes in, and given back with the last reference.
/// </summary>
internal sealed class StringPool(IndexBudget budget)
{
    /// <summary>A pool entry: the dictionary's slot and the entry object that counts references.</summary>
    public const long EntryBytes = 56;

    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private readonly Dictionary<PackedText, Entry> packed = [];
    /// <summary>References held across every text, and what the texts cost the budget together (the Memory panel's Nerd metrics).</summary>
    private long references, charged;

    private sealed class Entry(object value)
    {
        public object Value { get; } = value;
        public int Refs;
    }

    public IndexBudget Budget => budget;
    /// <summary>Distinct texts held (the checks read it).</summary>
    public int Count { get { lock (gate) return entries.Count + packed.Count; } }

    /// <summary>Distinct texts, the references taken to them, and what they cost the budget, read together.</summary>
    public (int Texts, long References, long Bytes) Stats { get { lock (gate) return (entries.Count + packed.Count, references, charged); } }

    /// <summary>What a text costs the budget while the pool holds it.</summary>
    public static long Cost(string value) => IndexMemory.StringBytes(value.Length) + EntryBytes;
    public static long Cost(object value) => (value is string text ? IndexMemory.StringBytes(text.Length) : ((PackedText)value).Bytes) + EntryBytes;

    /// <summary>One reference to the pool's copy of <paramref name="value"/>. A text the pool does not hold yet is charged first:
    /// null when that would leave less than <paramref name="keepFree"/> free, unless <paramref name="force"/>.</summary>
    public string? TryAcquire(string value, long keepFree = 0, bool force = false) => (string?)TryAcquire((object)value, keepFree, force);

    public PackedText? TryAcquire(PackedText value, long keepFree = 0, bool force = false) => (PackedText?)TryAcquire((object)value, keepFree, force);

    /// <summary>As the typed overloads, for a text of either form.</summary>
    public object? TryAcquire(object value, long keepFree = 0, bool force = false)
    {
        lock (gate)
        {
            if (!Find(value, out var entry))
            {
                var cost = Cost(value);
                if (force) budget.Force(cost);
                else if (!budget.TryTake(cost, keepFree)) return null;
                entry = new Entry(value);
                if (value is string text) entries[text] = entry;
                else packed[(PackedText)value] = entry;
                charged += cost;
            }
            entry.Refs++;
            references++;
            return entry.Value;
        }
    }

    private bool Find(object value, out Entry entry) =>
        value is string text ? entries.TryGetValue(text, out entry!) : packed.TryGetValue((PackedText)value, out entry!);

    /// <summary>Gives back one reference to each text; the last one drops the text and gives back its cost.</summary>
    public void Release(IEnumerable<object?> values)
    {
        lock (gate)
            foreach (var value in values)
            {
                if (value is null || !Find(value, out var entry)) continue;
                references--;
                if (--entry.Refs > 0) continue;
                if (value is string text) entries.Remove(text);
                else packed.Remove((PackedText)value);
                var cost = Cost(value);
                charged -= cost;
                budget.Release(cost);
            }
    }
}
