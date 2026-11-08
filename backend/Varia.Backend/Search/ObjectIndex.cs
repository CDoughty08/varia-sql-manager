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

    /// <summary><see cref="Label"/>'s length, without building it: a search reads it for every name it scans.</summary>
    public int LabelLength => Schema is not null ? Schema.Length + 1 + Name.Length : ParentName is not null ? (ParentSchema?.Length ?? 0) + ParentName.Length + 2 + Name.Length : Name.Length;
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

/// <summary>Finds a search's text in a name or a definition: literally (ordinal, with or without case, where * stands for any
/// characters and ? for one) or as a .NET regular expression under RegexOptions.NonBacktracking, whose time is linear in the
/// input whatever the pattern; Whole word keeps only matches with no identifier character (a letter, digit, _, @, # or $) on
/// either side.</summary>
internal sealed class SearchMatcher
{
    private readonly string text;
    private readonly StringComparison comparison;
    private readonly Regex? regex;
    private readonly bool wholeWord;
    /// <summary>For a plain search, the longest run of its text without a dot or wildcard: a name the search can match with a
    /// dot must contain it, which spares building the qualified name of every object that cannot.</summary>
    private readonly string hint;

    private SearchMatcher(string text, bool caseSensitive, bool wholeWord, Regex? regex, bool plain)
    {
        this.text = text;
        hint = plain ? text.Split(['.', '*', '?']).MaxBy(part => part.Length) ?? "" : "";
        comparison = caseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
        this.wholeWord = wholeWord;
        this.regex = regex;
    }

    /// <summary>The matcher, or the reason the pattern cannot be one (a syntax error, or a construct NonBacktracking lacks).</summary>
    public static (SearchMatcher? Matcher, string? Problem) Create(string text, bool caseSensitive, bool wholeWord, bool regex, TimeSpan timeout)
    {
        var options = RegexOptions.NonBacktracking | RegexOptions.CultureInvariant | RegexOptions.Multiline | (caseSensitive ? RegexOptions.None : RegexOptions.IgnoreCase);
        if (!regex)
        {
            var literal = wholeWord ? text : text.Trim('*');
            if (literal.IndexOfAny(['*', '?']) < 0) return (new SearchMatcher(literal, caseSensitive, wholeWord, null, true), null);
            return (new SearchMatcher(literal, caseSensitive, wholeWord, new Regex(Wildcard(literal), options, timeout), true), null);
        }
        try { return (new SearchMatcher(text, caseSensitive, wholeWord, new Regex(text, options, timeout), false), null); }
        catch (ArgumentException error) { return (null, Problem(error)); }
        catch (NotSupportedException) { return (null, "Regular expressions here cannot use lookarounds, backreferences, atomic groups or conditionals."); }
    }

    /// <summary>A plain search's wildcards as a pattern: * any characters on one line (as few as reach the rest), ? one character,
    /// everything else literal. A search matches anywhere in a name, so a plain search trims its outer *s first; under Whole word
    /// they are kept, and match the rest of the identifier (Cust* finds Customer).</summary>
    internal static string Wildcard(string text)
    {
        var pattern = new System.Text.StringBuilder(text.Length + 16);
        for (var at = 0; at < text.Length; at++)
        {
            var value = text[at];
            if (value == '?') pattern.Append('.');
            else if (value != '*') pattern.Append(Regex.Escape(value.ToString()));
            else
            {
                var first = at;
                while (at + 1 < text.Length && text[at + 1] == '*') at++;
                pattern.Append(first == 0 || at == text.Length - 1 ?"[\\p{L}\\p{Nd}_@#$]*" : ".*?");
            }
        }
        return pattern.ToString();
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

    /// <summary>Whether a plain search's longest literal run is in the object's qualified name or its database (always, for a
    /// regular expression). The run has no dot, so it lies within one part: the parts are tested without building the name.</summary>
    public bool Might(IndexedObject item, string? database) =>
        hint.Length == 0 || Has(item.Name) || Has(item.Schema) || Has(item.ParentSchema) || Has(item.ParentName) || Has(database);

    private bool Has(string? value) => value is not null && value.Contains(hint, comparison);

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

/// <summary>What a search asks: its text and options, where to look, and how many hits to answer. Fuzzy adds approximate name
/// matches (<see cref="FuzzyName"/>) below the exact ones; it never applies to a regular expression or to definitions.</summary>
internal sealed record SearchQuery(string Text, bool CaseSensitive, bool WholeWord, bool Regex, bool Names, bool Definitions, IReadOnlySet<string>? Kinds, string? Database, int Limit,
    bool Fuzzy = false);

/// <summary>Searches a connection's index. Names rank first (an exact name, then one that starts with the text, then any, then
/// under Fuzzy Match the approximate ones: every word found but apart, within edits, then by sound, each by fewest edits),
/// definition matches after them; within each, user objects before system ones, then by database, schema and name. The
/// resource database's objects are searched once, as master's (or the database the search names); the server's own objects
/// (which name no database) only by a search of the whole server.</summary>
internal static class IndexSearch
{
    /// <summary>A hit as the scan finds it, before its result is built: its rank, the object and where its name matched (From is
    /// -1 when only its definition did, whose first match it then carries). The scan keeps at most the candidate cap of these;
    /// labels are built only for the kept ones, and results (match counts, previews, dates) only for the best `limit`.</summary>
    private readonly record struct Candidate(int Rank, int Score, string? Database, IndexedObject Item, int From, int Length, bool Approximate, int DefinitionAt, int DefinitionLength);

    public static ObjectSearchResult Run(ConnectionIndex index, SearchQuery query, SearchMatcher matcher, ObjectIndexLimits limits, ObjectIndexStatus status, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        // The candidates, worst first: past the cap a better hit takes the worst one's place, so approximate or definition hits
        // scanned early never push out an exact one scanned later. Every other hit past the cap is only counted.
        var found = new PriorityQueue<Candidate, (int Rank, int Score, bool System)>(Comparer<(int Rank, int Score, bool System)>.Create((a, b) => b.CompareTo(a)));
        var fuzzy = query.Fuzzy && query.Names && !query.Regex ? FuzzyName.Create(query.Text, query.WholeWord) : null;
        var total = 0;
        var scanned = 0;
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
                // The budget and Stop are checked by objects scanned, not hits found: a search with few hits still reads every
                // definition, and a superseded search must not keep scanning on the thread pool.
                if ((++scanned & 63) == 0)
                {
                    token.ThrowIfCancellationRequested();
                    if (watch.Elapsed > limits.SearchBudget) { partial = true; goto done; }
                }
                if (query.Kinds is not null && !query.Kinds.Contains(item.Kind)) continue;
                if (!Match(name, item, query, matcher, fuzzy, dotted, out var candidate)) continue;
                total++;
                var key = (candidate.Rank, candidate.Score, item.System);
                if (found.Count < limits.Candidates) found.Enqueue(candidate, key);
                else
                {
                    partial = true;
                    if (found.TryPeek(out _, out var worst) && key.CompareTo(worst) < 0) found.DequeueEnqueue(candidate, key);
                }
            }
        }
    done:
        var best = found.UnorderedItems.Select(value => (Candidate: value.Element, Label: value.Element.Item.Label))
            .OrderBy(value => value.Candidate.Rank).ThenBy(value => value.Candidate.Score).ThenBy(value => value.Candidate.Item.System)
            .ThenBy(value => value.Candidate.Database ?? "", StringComparer.OrdinalIgnoreCase)
            .ThenBy(value => value.Label, StringComparer.OrdinalIgnoreCase).ThenBy(value => value.Label, StringComparer.Ordinal)
            .Take(query.Limit);
        // Counting a hit's definition matches can read its whole definition up to MatchesCounted times, so the budget and Stop
        // bound this work too: past the budget the result is partial, and the hits left are built only from what the scan found.
        var hits = new List<ObjectSearchHit>(Math.Min(query.Limit, found.Count));
        var late = watch.Elapsed > limits.SearchBudget;
        foreach (var (candidate, label) in best)
        {
            token.ThrowIfCancellationRequested();
            late = late || watch.Elapsed > limits.SearchBudget;
            hits.Add(Build(candidate, label, query, matcher, limits, watch, token, ref late));
        }
        return new(hits, total, partial || late, watch.ElapsedMilliseconds, status);
    }

    /// <summary>The rank of a hit only its definition matched.</summary>
    internal const int DefinitionRank = 6;

    /// <summary>Whether <paramref name="item"/> is a hit, with its rank and name range. Builds nothing for a name that matches
    /// without a dot; a definition is searched here only when the name did not match (the rank needs it), and a name hit's
    /// definition match waits for <see cref="Build"/>.</summary>
    private static bool Match(string? database, IndexedObject item, SearchQuery query, SearchMatcher matcher, FuzzyName? fuzzy, bool dotted, out Candidate candidate)
    {
        var rank = DefinitionRank;
        var score = 0;
        var approximate = false;
        var from = -1;
        var span = 0;
        if (query.Names)
        {
            var offset = item.LabelLength - item.Name.Length;
            if (matcher.Find(item.Name, 0, out var at, out var length))
            {
                (from, span) = (offset + at, length);
                rank = length == item.Name.Length ? 0 : at == 0 ? 1 : 2;
            }
            else if (dotted && query.Regex)
            {
                if (matcher.Find(item.Label, 0, out at, out length)) (from, span, rank) = (at, length, 2);
            }
            else if (dotted && matcher.Might(item, database))
            {
                // A plain search with a dot matches the qualified name between dots, so a dot marks where a part starts or
                // ends: .Sales finds the schema Sales and everything in it, Sales. too, and AppData.dbo.Orders the table in
                // that database. Only the label's part of the match is marked.
                var label = item.Label;
                var prefix = database is null ? 1 : database.Length + 2;
                if (matcher.Find(database is null ? "." + label + "." : "." + database + "." + label + ".", 0, out at, out length))
                {
                    var start = Math.Clamp(at - prefix, 0, label.Length);
                    var end = Math.Clamp(at + length - prefix, 0, label.Length);
                    (from, span) = (start, end - start);
                    rank = end == start ? 2 : start == 0 && end == label.Length ? 0 : start == 0 ? 1 : 2;
                }
            }
            if (from < 0 && fuzzy is not null && fuzzy.Match(item.Name, item.Schema ?? item.ParentSchema, item.ParentName, out var tier, out var cost, out var word, out var width))
            {
                (from, span) = (offset + word, width);
                (rank, score, approximate) = (3 + (int)tier, cost, true);
            }
        }
        var definitionAt = -1;
        var definitionLength = 0;
        if (from < 0 && !(query.Definitions && item.Definition is { } text && matcher.Find(text, 0, out definitionAt, out definitionLength)))
        {
            candidate = default;
            return false;
        }
        candidate = new(rank, score, database, item, from, span, approximate, definitionAt, definitionLength);
        return true;
    }

    /// <summary>The result of a hit the search answers: its definition's match count and preview, its ref and its date. Once the
    /// search is <paramref name="late"/> (past its budget, which the count also checks) the definition is searched no further: a
    /// definition hit shows the match the scan found, its count only what was counted, and a name hit shows no definition match.</summary>
    private static ObjectSearchHit Build(Candidate hit, string label, SearchQuery query, SearchMatcher matcher, ObjectIndexLimits limits, Stopwatch watch, CancellationToken token,
        ref bool late)
    {
        var item = hit.Item;
        DefinitionMatch? definition = null;
        var (first, size) = (hit.DefinitionAt, hit.DefinitionLength);
        if (query.Definitions && item.Definition is { } text && (first >= 0 || !late && matcher.Find(text, 0, out first, out size)))
        {
            var count = 1;
            for (var next = first + Math.Max(1, size); !late && count < limits.MatchesCounted && next <= text.Length && matcher.Find(text, next, out var again, out var width); count++)
            {
                next = again + Math.Max(1, width);
                token.ThrowIfCancellationRequested();
                late = watch.Elapsed > limits.SearchBudget;
            }
            definition = Preview(text, first, size, count, limits.PreviewChars, item.DefinitionCut);
        }
        var value = new ObjectRefDto(item.Kind, hit.Database, item.Schema, item.Name, item.ParentName is null ? null : new ParentRefDto(item.ParentKind!, item.ParentSchema!, item.ParentName));
        return new(value, item.Folder, label, hit.From < 0 ? null : [hit.From, hit.Length], item.Modified?.ToString("yyyy-MM-ddTHH:mm:ss", System.Globalization.CultureInfo.InvariantCulture),
            definition, item.Subtype, item.ParentFolder, item.Via is { } via ? new ViaRefDto(via.Schema!, via.Name, via.Folder) : null, hit.Approximate ? true : null);
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
