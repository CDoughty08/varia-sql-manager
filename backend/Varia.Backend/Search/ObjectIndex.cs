using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Varia.Backend.Search;

/// <summary>One indexed object: its Object Explorer identity (kind, subtype, schema, name and, for a child such as a column or a
/// DML trigger, its parent and the folder that lists the parent), the folder that lists it, its definition when it has one the
/// login may read (a module's, a constraint's or computed column's expression, a plan guide's statement), cut at the index's
/// per-module limit, and whether it is a system object (Microsoft-shipped, a database diagrams support object, a fixed role or a
/// built-in principal or schema), which ranks after user ones. A server object or a database has no database of its own. Via is
/// the table a temporal or ledger history table is shown below (as its history row), for the history table and its children.</summary>
internal sealed record IndexedObject(string Kind, string Folder, string? Schema, string Name, string? ParentKind = null, string? ParentSchema = null, string? ParentName = null,
    DateTime? Modified = null, string? Definition = null, bool DefinitionCut = false, bool System = false, string? Subtype = null, string? ParentFolder = null, IndexedObject? Via = null)
{
    /// <summary>What the results show and a name search with a dot matches: schema.name, or the parent's for a child.</summary>
    public string Label => Schema is not null ? Schema + "." + Name : ParentName is not null ? ParentSchema + "." + ParentName + "." + Name : Name;
}

/// <summary>One database's objects as one read of its catalog left them; replaced whole by the next read.</summary>
internal sealed class DatabaseIndex(string database, IndexedObject[] objects, long bytes, int modules, int cut, long credited = 0, DatabaseIndex? creditFrom = null,
    string[]? pooled = null)
{
    public string Database { get; } = database;
    public IndexedObject[] Objects { get; } = objects;
    /// <summary>The memory its records hold (<see cref="IndexMemory"/>), charged against the index's budget until the database is
    /// replaced or dropped. Its names and definitions are the pool's (<see cref="Pooled"/>).</summary>
    public long Bytes { get; } = bytes;
    /// <summary>The distinct texts it holds a <see cref="StringPool"/> reference to, given back with it.</summary>
    public string[] Pooled { get; } = pooled ?? [];
    /// <summary>The part of <see cref="Bytes"/> the read took from the share of the index it replaces (<see cref="CreditFrom"/>)
    /// rather than from the budget: the swap moves that share over instead of giving it back.</summary>
    public long Credited { get; } = credited;
    public DatabaseIndex? CreditFrom { get; } = creditFrom;
    public int Modules { get; } = modules;
    /// <summary>Definitions cut at the per-module limit, or left out once the budget was spent.</summary>
    public int Cut { get; } = cut;
}

/// <summary>What the index charges for what it holds: a deterministic estimate of the managed memory of each record (with its
/// slot in the array that holds it), of each distinct text in the <see cref="StringPool"/> (charged once, whatever the records,
/// databases and connections that share it), and of each database's slot for a text it holds a reference to.</summary>
internal static class IndexMemory
{
    /// <summary>An <see cref="IndexedObject"/> on 64-bit .NET: header and method table, eleven references, a nullable DateTime and
    /// two flags, plus the array slot.</summary>
    public const long RecordBytes = 136;

    /// <summary>A database's reference to one pooled text (<see cref="DatabaseIndex.Pooled"/>).</summary>
    public const long SlotBytes = 8;

    /// <summary>A string of <paramref name="length"/> UTF-16 code units: header, method table, length and terminator, 8-aligned.</summary>
    public static long StringBytes(int length) => (22L + 2L * length + 7) & ~7L;
}

/// <summary>Bounds on the index and its searches (objectSearchLimits in src/shared/explorer/search.ts).</summary>
internal sealed class ObjectIndexLimits
{
    /// <summary>The memory every connection's index holds together (<see cref="IndexMemory"/>): a database that would pass it is
    /// read again without its children (CHILDREN_LEFT_OUT), and one that still would is skipped as TOO_LARGE.</summary>
    public long MemoryBytes { get; init; } = 512L * 1024 * 1024;
    /// <summary>The part of <see cref="MemoryBytes"/> definitions leave to names: a definition is left out (counted as cut) once
    /// less than this is free.</summary>
    public long NamesReserveBytes { get; init; } = 128L * 1024 * 1024;
    /// <summary>The longest part of one definition the index keeps.</summary>
    public int DefinitionChars { get; init; } = 1_000_000;
    /// <summary>Databases indexed at once across every connection, and per connection.</summary>
    public int Total { get; init; } = 2;
    /// <summary>One database's read; a slower one is skipped as TIMEOUT.</summary>
    public TimeSpan DatabaseBudget { get; set; } = TimeSpan.FromSeconds(120);
    /// <summary>One search's work; a slower search answers what it found, marked partial.</summary>
    public TimeSpan SearchBudget { get; set; } = TimeSpan.FromSeconds(5);
    /// <summary>A regular expression's own bound per match (NonBacktracking runs in linear time; this bounds a huge input).</summary>
    public TimeSpan MatchTimeout { get; init; } = TimeSpan.FromSeconds(2);
    /// <summary>Hits a search may sort before it keeps the best `limit`; past it, the count goes on and the result is partial.</summary>
    public int Candidates { get; init; } = 20_000;
    /// <summary>Matches counted in one definition.</summary>
    public int MatchesCounted { get; init; } = 999;
    /// <summary>The preview's length around a definition match.</summary>
    public int PreviewChars { get; init; } = 160;
}

/// <summary>The memory held by every connection's index (<see cref="IndexMemory"/>), in bytes.</summary>
internal sealed class IndexBudget(long limit)
{
    private long used;
    public long Limit => limit;
    public long Used => Interlocked.Read(ref used);

    /// <summary>Takes <paramref name="bytes"/> when that leaves at least <paramref name="keepFree"/> of the limit free.</summary>
    public bool TryTake(long bytes, long keepFree = 0)
    {
        while (true)
        {
            var current = Interlocked.Read(ref used);
            if (current + bytes > limit - keepFree) return false;
            if (Interlocked.CompareExchange(ref used, current + bytes, current) == current) return true;
        }
    }

    /// <summary>Takes <paramref name="bytes"/> whatever the limit: memory already held that moves to a new owner, or the shared
    /// system objects, which every connection needs and holds once.</summary>
    public void Force(long bytes) => Interlocked.Add(ref used, bytes);
    public void Release(long bytes) => Interlocked.Add(ref used, -bytes);
}

/// <summary>A connection's index: the server's own objects (its databases, logins, roles and other server objects) and its
/// databases, each swapped in whole as its read completes, so a search during a rebuild sees every part either as it was or as
/// it is now, and its share of the resource database's objects (<see cref="ResourceCatalog"/>), which every database shows and
/// the index holds once. Replacing or dropping a database gives back its records' share and its references to pooled texts.</summary>
internal sealed class ConnectionIndex(IndexBudget budget, ResourceCatalog? resources = null, StringPool? pool = null)
{
    private readonly object gate = new();
    private Dictionary<string, DatabaseIndex> databases = new(StringComparer.Ordinal);
    private ResourceSet? resource;
    private DatabaseIndex? server;
    public bool Disposed { get; private set; }

    public IReadOnlyCollection<DatabaseIndex> Databases { get { lock (gate) return [.. databases.Values]; } }
    public ResourceSet? Resource { get { lock (gate) return resource; } }
    /// <summary>The server's own objects, whose refs name no database.</summary>
    public DatabaseIndex? Server { get { lock (gate) return server; } }
    public int Objects { get { lock (gate) return databases.Values.Sum(value => value.Objects.Length) + (resource?.Objects.Length ?? 0) + (server?.Objects.Length ?? 0); } }

    /// <summary>Holds the server's objects in place of those held before, whose share goes back (or over to the new read).</summary>
    public void PutServer(DatabaseIndex value)
    {
        lock (gate)
        {
            if (Disposed) { Drop(value, value.Bytes - value.Credited); return; }
            Settle(server, value);
            server = value;
        }
    }

    /// <summary>Gives back <paramref name="old"/>'s share, less what <paramref name="value"/>'s read took from it. When the read's
    /// credit came from an index no longer held (a listing dropped it meanwhile, so its share went back), the new read takes it
    /// from the budget instead.</summary>
    private void Settle(DatabaseIndex? old, DatabaseIndex value)
    {
        // The new read already holds its own references, so texts both reads hold stay in the pool.
        if (old is not null && ReferenceEquals(old, value.CreditFrom)) { Drop(old, old.Bytes - value.Credited); return; }
        if (old is not null) Drop(old, old.Bytes);
        if (value.Credited > 0) budget.Force(value.Credited);
    }

    private void Drop(DatabaseIndex value, long bytes)
    {
        budget.Release(bytes);
        pool?.Release(value.Pooled);
    }

    /// <summary>Holds <paramref name="value"/> (a reference already taken) in place of the set held before, whose reference goes back.</summary>
    public void PutResource(ResourceSet? value)
    {
        ResourceSet? drop;
        lock (gate)
        {
            // A disconnected index keeps nothing, and the same set put again gives back its second reference.
            if (Disposed || ReferenceEquals(resource, value)) drop = value;
            else { drop = resource; resource = value; }
        }
        if (drop is not null) resources?.Release(drop);
    }

    public void Put(DatabaseIndex value)
    {
        lock (gate)
        {
            if (Disposed) { Drop(value, value.Bytes - value.Credited); return; }
            databases.Remove(value.Database, out var old);
            Settle(old, value);
            databases[value.Database] = value;
        }
    }

    /// <summary>Drops the databases a new listing no longer names.</summary>
    public void Keep(IReadOnlySet<string> names)
    {
        lock (gate)
            foreach (var name in databases.Keys.Where(name => !names.Contains(name)).ToList())
                if (databases.Remove(name, out var old)) Drop(old, old.Bytes);
    }

    public void Dispose()
    {
        ResourceSet? old;
        lock (gate)
        {
            Disposed = true;
            foreach (var value in databases.Values) Drop(value, value.Bytes);
            databases = new(StringComparer.Ordinal);
            if (server is not null) Drop(server, server.Bytes);
            server = null;
            old = resource;
            resource = null;
        }
        if (old is not null) resources?.Release(old);
    }
}

/// <summary>Finds a search's text in a name or a definition: literally (ordinal, with or without case) or as a .NET regular
/// expression under RegexOptions.NonBacktracking, whose time is linear in the input whatever the pattern; Whole word keeps
/// only matches with no identifier character (a letter, digit, _, @, # or $) on either side.</summary>
internal sealed class SearchMatcher
{
    private readonly string text;
    private readonly StringComparison comparison;
    private readonly Regex? regex;
    private readonly bool wholeWord;

    private SearchMatcher(string text, bool caseSensitive, bool wholeWord, Regex? regex)
    {
        this.text = text;
        comparison = caseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
        this.wholeWord = wholeWord;
        this.regex = regex;
    }

    /// <summary>The matcher, or the reason the pattern cannot be one (a syntax error, or a construct NonBacktracking lacks).</summary>
    public static (SearchMatcher? Matcher, string? Problem) Create(string text, bool caseSensitive, bool wholeWord, bool regex, TimeSpan timeout)
    {
        if (!regex) return (new SearchMatcher(text, caseSensitive, wholeWord, null), null);
        var options = RegexOptions.NonBacktracking | RegexOptions.CultureInvariant | RegexOptions.Multiline | (caseSensitive ? RegexOptions.None : RegexOptions.IgnoreCase);
        try { return (new SearchMatcher(text, caseSensitive, wholeWord, new Regex(text, options, timeout)), null); }
        catch (ArgumentException error) { return (null, Problem(error)); }
        catch (NotSupportedException) { return (null, "Regular expressions here cannot use lookarounds, backreferences, atomic groups or conditionals."); }
    }

    private static string Problem(ArgumentException error) =>
        error is RegexParseException parse ? "The regular expression is not valid at offset " + parse.Offset + ": " + Describe(parse.Error) + "."
        : error.Message.Contains("NonBacktracking", StringComparison.Ordinal) ? "Regular expressions here cannot use lookarounds, backreferences, atomic groups or conditionals."
        : "The regular expression is not valid.";

    private static string Describe(RegexParseError error) => error switch
    {
        RegexParseError.InsufficientClosingParentheses => "a group is not closed",
        RegexParseError.InsufficientOpeningParentheses => "a ) has no (",
        RegexParseError.UnterminatedBracket => "a [ is not closed",
        RegexParseError.QuantifierAfterNothing => "a quantifier follows nothing",
        RegexParseError.NestedQuantifiersNotParenthesized => "quantifiers are nested",
        RegexParseError.UnescapedEndingBackslash => "it ends with a \\",
        _ => "unexpected " + error
    };

    /// <summary>The first match at or after <paramref name="start"/>.</summary>
    public bool Find(string value, int start, out int index, out int length)
    {
        while (start <= value.Length)
        {
            if (regex is not null)
            {
                var match = regex.Match(value, start);
                if (!match.Success) break;
                (index, length) = (match.Index, match.Length);
            }
            else
            {
                var at = text.Length == 0 ? -1 : value.IndexOf(text, start, comparison);
                if (at < 0) break;
                (index, length) = (at, text.Length);
            }
            if (!wholeWord || Bounded(value, index, length)) return true;
            start = index + Math.Max(1, length);
        }
        (index, length) = (-1, 0);
        return false;
    }

    private static bool Bounded(string value, int index, int length) =>
        length > 0 && (index == 0 || !Word(value[index - 1])) && (index + length >= value.Length || !Word(value[index + length]));

    internal static bool Word(char value) => char.IsLetterOrDigit(value) || value is '_' or '@' or '#' or '$';
}

/// <summary>What a search asks: its text and options, where to look, and how many hits to answer.</summary>
internal sealed record SearchQuery(string Text, bool CaseSensitive, bool WholeWord, bool Regex, bool Names, bool Definitions, IReadOnlySet<string>? Kinds, string? Database, int Limit);

/// <summary>Searches a connection's index. Names rank first (an exact name, then one that starts with the text, then any),
/// definition matches after them; within each, user objects before system ones, then by database, schema and name. The
/// resource database's objects are searched once, as master's (or the database the search names); the server's own objects
/// (which name no database) only by a search of the whole server.</summary>
internal static class IndexSearch
{
    public static ObjectSearchResult Run(ConnectionIndex index, SearchQuery query, SearchMatcher matcher, ObjectIndexLimits limits, ObjectIndexStatus status)
    {
        var watch = Stopwatch.StartNew();
        var found = new List<(int Rank, bool System, ObjectSearchHit Hit)>();
        var total = 0;
        var partial = false;
        var dotted = query.Text.Contains('.');
        var databases = index.Databases.OrderBy(value => value.Database, StringComparer.OrdinalIgnoreCase).ToList();
        var sources = new List<(string? Database, IndexedObject[] Objects)>();
        if (query.Database is null && index.Server is { } server) sources.Add((null, server.Objects));
        sources.AddRange(databases.Where(value => query.Database is null || string.Equals(value.Database, query.Database, StringComparison.Ordinal))
            .Select(value => ((string?)value.Database, value.Objects)));
        if (index.Resource is { } resource)
            sources.Add((query.Database ?? databases.FirstOrDefault(value => value.Database == "master")?.Database ?? databases.FirstOrDefault()?.Database ?? "master", resource.Objects));
        foreach (var (name, objects) in sources)
        {
            foreach (var item in objects)
            {
                if (query.Kinds is not null && !query.Kinds.Contains(item.Kind)) continue;
                if ((total & 255) == 0 && watch.Elapsed > limits.SearchBudget) { partial = true; goto done; }
                var hit = Match(name, item, query, matcher, limits, dotted, out var rank);
                if (hit is null) continue;
                total++;
                if (found.Count < limits.Candidates) found.Add((rank, item.System, hit));
                else partial = true;
            }
        }
    done:
        var hits = found.OrderBy(value => value.Rank).ThenBy(value => value.System).ThenBy(value => value.Hit.Object.Database ?? "", StringComparer.OrdinalIgnoreCase)
            .ThenBy(value => value.Hit.Label, StringComparer.OrdinalIgnoreCase).ThenBy(value => value.Hit.Label, StringComparer.Ordinal)
            .Take(query.Limit).Select(value => value.Hit).ToList();
        return new(hits, total, partial, watch.ElapsedMilliseconds, status);
    }

    private static ObjectSearchHit? Match(string? database, IndexedObject item, SearchQuery query, SearchMatcher matcher, ObjectIndexLimits limits, bool dotted, out int rank)
    {
        rank = 3;
        var label = item.Label;
        int[]? range = null;
        if (query.Names)
        {
            var offset = label.Length - item.Name.Length;
            if (matcher.Find(item.Name, 0, out var at, out var length))
            {
                range = [offset + at, length];
                rank = length == item.Name.Length ? 0 : at == 0 ? 1 : 2;
            }
            else if (dotted && matcher.Find(label, 0, out at, out length))
            {
                range = [at, length];
                rank = 2;
            }
        }
        DefinitionMatch? definition = null;
        if (query.Definitions && item.Definition is { } text && matcher.Find(text, 0, out var first, out var size))
        {
            var count = 1;
            for (var next = first + Math.Max(1, size); count < limits.MatchesCounted && next <= text.Length && matcher.Find(text, next, out var again, out var width); count++)
                next = again + Math.Max(1, width);
            definition = Preview(text, first, size, count, limits.PreviewChars, item.DefinitionCut);
        }
        if (range is null && definition is null) return null;
        var value = new ObjectRefDto(item.Kind, database, item.Schema, item.Name, item.ParentName is null ? null : new ParentRefDto(item.ParentKind!, item.ParentSchema!, item.ParentName));
        return new(value, item.Folder, label, range, item.Modified?.ToString("yyyy-MM-ddTHH:mm:ss", System.Globalization.CultureInfo.InvariantCulture), definition, item.Subtype, item.ParentFolder,
            item.Via is { } via ? new ViaRefDto(via.Schema!, via.Name, via.Folder) : null);
    }

    /// <summary>The match's line (1-based) and column, and up to <paramref name="chars"/> characters of that line around it.</summary>
    internal static DefinitionMatch Preview(string text, int index, int length, int count, int chars, bool cut)
    {
        var line = 1;
        for (var at = text.IndexOf('\n'); at >= 0 && at < index; at = text.IndexOf('\n', at + 1)) line++;
        var start = index == 0 ? 0 : text.LastIndexOf('\n', index - 1) + 1;
        var end = text.IndexOf('\n', index);
        if (end < 0) end = text.Length;
        if (end > start && text[end - 1] == '\r') end--;
        // A match that spans lines shows up to its own line's end.
        var shown = Math.Min(length, Math.Max(0, end - index));
        var from = Math.Max(start, Math.Min(index - (chars - shown) / 3, end - chars));
        var to = Math.Min(end, Math.Max(from + chars, index + shown));
        if (to - from > chars) to = from + chars;
        from = Math.Max(start, from);
        var preview = text[from..to].Replace('\t', ' ');
        return new(line, index - start + 1, preview, [index - from, Math.Min(shown, to - index)], from > start, to < end, count, cut);
    }
}
