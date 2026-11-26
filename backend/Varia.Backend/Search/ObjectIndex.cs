using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Varia.Backend.Search;

/// <summary>One indexed object as a record, the form a read composes and checks compare; the index itself holds objects packed in an
/// <see cref="ObjectTable"/>. Its Object Explorer identity (kind, subtype, schema, name and, for a child such as a column or a
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
internal sealed class DatabaseIndex(string database, ObjectTable table, long bytes, int modules, int cut, long credited = 0, DatabaseIndex? creditFrom = null,
    bool pooled = false, DateTime? readAt = null)
{
    private readonly object gate = new();
    private TableLookup? lookup;
    private long lookupBytes;
    private bool dropped;

    /// <summary>An index of <paramref name="objects"/> as they are, holding no pool references (checks and benchmarks).</summary>
    public DatabaseIndex(string database, IndexedObject[] objects, long bytes, int modules, int cut) : this(database, ObjectTable.Of(objects), bytes, modules, cut) { }

    /// <summary>The database; for BigQuery, the project.</summary>
    public string Database { get; } = database;
    /// <summary>BigQuery: the dataset whose objects this holds (its schema, in the table); null for a project's own entry and for SQL Server.</summary>
    public string? Dataset { get; init; }
    /// <summary>What the connection's index holds it under: the database, or for a BigQuery dataset its project and name.</summary>
    public string Key => Dataset is null ? Database : Database + "\u0001" + Dataset;
    /// <summary>BigQuery's facts beside the entries (creation times, rows, size, layout, shard groups, column descriptions), or null.</summary>
    public BigQueryFacts? Facts { get; init; }
    public ObjectTable Table { get; } = table;
    /// <summary>The memory its records hold (<see cref="IndexMemory"/>), charged against the index's budget until the database is
    /// replaced or dropped. Its names and definitions are the pool's (<see cref="Pooled"/>).</summary>
    public long Bytes { get; } = bytes;
    /// <summary>The distinct texts it holds a <see cref="StringPool"/> reference to, given back with it: a read's table's texts.</summary>
    public object[] Pooled { get; } = pooled ? [.. table.Texts.OfType<object>()] : [];
    /// <summary>The part of <see cref="Bytes"/> the read took from the share of the index it replaces (<see cref="CreditFrom"/>)
    /// rather than from the budget: the swap moves that share over instead of giving it back.</summary>
    public long Credited { get; } = credited;
    /// <summary>Let go once the read is held (or dropped), so a held read does not keep every read before it alive.</summary>
    public DatabaseIndex? CreditFrom { get; private set; } = creditFrom;
    internal void Credit() => CreditFrom = null;
    public int Modules { get; } = modules;
    /// <summary>Definitions cut at the per-module limit, or left out once the budget was spent.</summary>
    public int Cut { get; } = cut;
    /// <summary>The part of <see cref="Cut"/> left out whole because the index's memory ran out (the names' reserve, or
    /// BigQuery's floor), which the status reports apart: a search inside definitions cannot find these.</summary>
    public int LeftOut { get; init; }
    /// <summary>Read without its children (CHILDREN_LEFT_OUT) because with them it did not fit: set before it is held, and kept
    /// with it however later builds end, for the Memory panel's Nerd metrics.</summary>
    public bool ChildrenLeftOut { get; set; }
    /// <summary>Read by a build without definitions: no entry has one.</summary>
    public bool DefinitionsLeftOut { get; set; }
    /// <summary>BigQuery: the read holds some object's details (its columns): what a later read of the dataset keeps hold of.</summary>
    public bool Detailed { get; init; }
    /// <summary>BigQuery: the part of <see cref="Bytes"/> its names hold (records, facts, text slots). A read that replaces this
    /// one charges its names to that part and its details to the rest, so neither pushes the other out of the share.</summary>
    public long NameBytes { get; init; }
    /// <summary>Whether the database's object names tell case apart (<see cref="ObjectSearchSql.CaseSensitive"/>); null where the
    /// read did not reach it (a batch that failed part way).</summary>
    public bool? CaseSensitive { get; set; }

    /// <summary>Whether, ignoring case otherwise, the collation tells i from I (Turkish and Azeri: i pairs with İ and ı with I);
    /// the second column of <see cref="ObjectSearchSql.CaseSensitive"/>.</summary>
    public bool DottedI { get; set; }

    /// <summary>When the read was made, on <see cref="IndexClock"/>: what the lookup orders reads and skips by.</summary>
    public long Stamp { get; } = IndexClock.Next();
    /// <summary>Held after its read failed part way (KeepPartial): it has only what came before the failure, whatever the build
    /// records of it (set before it is held, so a lookup never sees it as whole).</summary>
    public bool FailedPart { get; set; }
    /// <summary>When the read finished (UTC): how stale the editor's metadata may be.</summary>
    public DateTime ReadAt { get; } = readAt ?? DateTime.UtcNow;

    /// <summary>What its lookup arrays (<see cref="TableLookup"/>) hold of the budget: 0 until the first lookup builds them.</summary>
    public long LookupBytes { get { lock (gate) return lookupBytes; } }

    private int lookupBuilds;
    private bool lookupBuilding;

    /// <summary>How many times this read's lookup arrays were built (a check's view: at most once, and never when refused).</summary>
    internal int LookupBuilds => Volatile.Read(ref lookupBuilds);

    /// <summary>A check's hook: called once the build is claimed, before the arrays are built.</summary>
    internal Action? LookupBuilding { get; set; }

    /// <summary>The lookup arrays, built on the first lookup and charged to <paramref name="budget"/> until the database is dropped;
    /// <paramref name="built"/> is told when this call built them. Null once it is dropped, while another call is building them, or
    /// when the budget cannot take them and leave <paramref name="keepFree"/> free (BigQuery's floor): the lookup then scans the table.</summary>
    public TableLookup? Lookup(IndexBudget budget, Action? built = null, long keepFree = 0)
    {
        if (Volatile.Read(ref lookup) is { } held) return held;
        var bytes = TableLookup.BytesFor(Table);
        // Claimed and charged under the gate, so one call builds and a budget that refuses costs no build; built outside it,
        // since Put, Keep and Dispose take it. A build that throws, or finds the read dropped, gives the charge back.
        lock (gate)
        {
            if (lookup is not null || dropped || lookupBuilding) return lookup;
            if (!budget.TryTake(bytes, keepFree)) return null;
            lookupBuilding = true;
        }
        TableLookup made;
        try
        {
            LookupBuilding?.Invoke();
            made = TableLookup.Build(Table);
            Interlocked.Increment(ref lookupBuilds);
        }
        catch
        {
            lock (gate) lookupBuilding = false;
            budget.Release(bytes);
            throw;
        }
        lock (gate)
        {
            lookupBuilding = false;
            if (dropped)
            {
                budget.Release(bytes);
                return null;
            }
            lookupBytes = bytes;
            Volatile.Write(ref lookup, made);
        }
        built?.Invoke();
        return made;
    }

    /// <summary>Gives back its lookup arrays' share once the index no longer holds it; a later lookup builds none.</summary>
    public void Dropped(IndexBudget budget)
    {
        lock (gate)
        {
            dropped = true;
            budget.Release(lookupBytes);
            lookupBytes = 0;
            Volatile.Write(ref lookup, null);
        }
    }
}

/// <summary>What the index charges for what it holds: a deterministic estimate of the managed memory of each record (with its
/// slot in the array that holds it), of each distinct text in the <see cref="StringPool"/> (charged once, whatever the records,
/// databases and connections that share it), and of each database's slot for a text it holds a reference to.</summary>
internal static class IndexMemory
{
    /// <summary>An <see cref="ObjectEntry"/> in its table's array: four text or object ids, a date, a shape id and flags. (An
    /// <see cref="IndexedObject"/> record with its array slot took 136.)</summary>
    public const long RecordBytes = 24;

    /// <summary>A database's reference to one pooled text (<see cref="DatabaseIndex.Pooled"/>).</summary>
    public const long SlotBytes = 8;

    /// <summary>A type in a table's <see cref="ObjectDetails"/>: its name's and schema's text ids, its id, its system type id and flags.</summary>
    public const long TypeBytes = 16;
    /// <summary>A column's, parameter's or function's type: its entry, type, length, precision, scale, ordinal and flags.</summary>
    public const long TypedBytes = 13;
    /// <summary>An index's or key's column list: its entry, where its columns start, how many, and a foreign key's table.</summary>
    public const long KeyBytes = 14;
    /// <summary>One column of an index or key: its column_id, a foreign key's referenced column_id, and flags.</summary>
    public const long KeyColumnBytes = 5;

    /// <summary>A string of <paramref name="length"/> UTF-16 code units: header, method table, length and terminator, 8-aligned.</summary>
    public static long StringBytes(int length) => (22L + 2L * length + 7) & ~7L;
}

/// <summary>Bounds on the index and its searches (objectSearchLimits in src/shared/explorer/search.ts).</summary>
internal sealed class ObjectIndexLimits
{
    /// <summary>The memory limit in MiB as Options sets it (objectExplorer.search.memoryLimitMiB): its default and bounds.</summary>
    public const int DefaultMemoryMiB = 512;
    public const int MinMemoryMiB = 64;
    public const int MaxMemoryMiB = 16_384;
    /// <summary>The names' reserve is one part in this many of the limit.</summary>
    public const int NamesReserveShare = 4;

    /// <summary>The memory every connection's index holds together (<see cref="IndexMemory"/>): a database that would pass it is
    /// read again without its children (CHILDREN_LEFT_OUT), and one that still would is skipped as TOO_LARGE. A build may
    /// change it (<see cref="ObjectSearchService.SetMemoryLimit"/>).</summary>
    public long MemoryBytes { get; set; } = DefaultMemoryMiB * 1024L * 1024;
    /// <summary>The part of <see cref="MemoryBytes"/> definitions leave to names: a definition is left out (counted as cut) once
    /// less than this is free.</summary>
    public long NamesReserveBytes { get; set; } = DefaultMemoryMiB * 1024L * 1024 / NamesReserveShare;
    // What a BigQuery read keeps free, so that however much BigQuery metadata is indexed, and whichever connection was built
    // first, a SQL Server read still finds room above the names' reserve for its definitions. Each floor is the names' reserve
    // and a part more, so BigQuery gives way in order: discovered projects' details first, then the billing and starred
    // projects', then names. A floor only refuses BigQuery; SQL Server's reads never see it.
    /// <summary>Kept free by everything a BigQuery index holds (names, records, lookup arrays): 3/8 of the limit.</summary>
    public long BigQueryNamesFloorBytes => NamesReserveBytes + NamesReserveBytes / 2;
    /// <summary>Kept free by the billing and starred projects' details (columns, view and routine text): 7/16 of the limit.</summary>
    public long BigQueryDetailsFloorBytes => NamesReserveBytes + NamesReserveBytes / 4 * 3;
    /// <summary>Kept free by discovered projects' details, the first to give way: half the limit.</summary>
    public long BigQueryDiscoveredFloorBytes => NamesReserveBytes * 2;

    /// <summary>The floor a BigQuery dataset's details keep free: its project's, or one step lower for a dataset that already
    /// <paramref name="holds"/> details, so what it holds can grow a little (a column added, a table recreated a little wider)
    /// without the dataset losing its columns at the very line the build stopped at.</summary>
    public long BigQueryDetailsFloor(bool discovered, bool holds) =>
        discovered ? holds ? BigQueryDetailsFloorBytes : BigQueryDiscoveredFloorBytes : holds ? BigQueryNamesFloorBytes : BigQueryDetailsFloorBytes;
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

/// <summary>Bounds on one saved unit of the index (<see cref="IndexFile"/>). A file is untrusted input: the loader checks every
/// length and count against these before it allocates anything by them, and the writer refuses a unit past them rather than
/// write a file no reader takes. Beyond these, whatever a load keeps is charged to the index's budget as a read's is.</summary>
internal static class IndexFileLimits
{
    /// <summary>One file, header and body.</summary>
    public const long FileBytes = 4L << 30;
    /// <summary>Entries in one unit's table, and in the shared resource set's (which is charged whatever the budget holds).</summary>
    public const int Objects = 1 << 26;
    public const int ResourceObjects = 1 << 21;
    /// <summary>Distinct texts in one unit's table.</summary>
    public const int Texts = 1 << 27;
    /// <summary>One text, a name or a definition, in UTF-16 code units: four times the longest definition the index keeps by default.</summary>
    public const int TextChars = 4 << 20;
    /// <summary>The kind, folder and subtype combinations one unit names (the process knows a few hundred), and each one's length.</summary>
    public const int Shapes = 4096;
    public const int ShapeChars = 64;
    /// <summary>A unit's types (<see cref="ObjectDetails"/> numbers them in 16 bits) and the columns its indexes and keys list.</summary>
    public const int Types = ushort.MaxValue + 1;
    public const int KeyColumns = 1 << 27;
    /// <summary>A database's, project's or dataset's name, or a server's version.</summary>
    public const int NameChars = 1024;
    /// <summary>A BigQuery fact's text (a signature, a description, a shard group's prefix): well above <see cref="BigQueryIndexLimits.FactChars"/>.</summary>
    public const int FactChars = 4096;
    /// <summary>The caller's identity and sync state in the header, and the opaque bytes it may keep in the body.</summary>
    public const int IdentityBytes = 1024;
    public const int SyncBytes = 1 << 20;
    public const int ExtraBytes = 32 << 20;
}

/// <summary>The memory held by every connection's index (<see cref="IndexMemory"/>), in bytes.</summary>
internal sealed class IndexBudget(long limit)
{
    private long used;
    private long cap = limit;
    /// <summary>A limit set below what is held drops nothing: it only refuses what is asked from then on, until enough has
    /// been given back.</summary>
    public long Limit { get => Interlocked.Read(ref cap); set => Interlocked.Exchange(ref cap, value); }
    public long Used => Interlocked.Read(ref used);
    /// <summary>What is left of the limit; negative while a lowered limit is below what is held.</summary>
    public long Free => Limit - Used;

    /// <summary>Takes <paramref name="bytes"/> when that leaves at least <paramref name="keepFree"/> of the limit free.</summary>
    public bool TryTake(long bytes, long keepFree = 0)
    {
        while (true)
        {
            var current = Interlocked.Read(ref used);
            if (current + bytes > Limit - keepFree) return false;
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
    private DatabaseIndex? agent;
    public bool Disposed { get; private set; }

    public IReadOnlyCollection<DatabaseIndex> Databases { get { lock (gate) return [.. databases.Values]; } }
    public ResourceSet? Resource { get { lock (gate) return resource; } }
    /// <summary>The server's own objects, whose refs name no database.</summary>
    public DatabaseIndex? Server { get { lock (gate) return server; } }
    public int Objects { get { lock (gate) return databases.Values.Sum(value => value.Table.Count) + (resource?.Table.Count ?? 0) + (server?.Table.Count ?? 0) + (agent?.Table.Count ?? 0); } }
    /// <summary>SQL Server Agent's objects (jobs, alerts, operators), read apart from the server's, whose refs name no database.</summary>
    public DatabaseIndex? Agent { get { lock (gate) return agent; } }
    /// <summary>Every database index it holds, the server's and Agent's included, read together (the Memory panel's Nerd metrics).</summary>
    public List<DatabaseIndex> Held
    {
        get
        {
            lock (gate)
            {
                var held = new List<DatabaseIndex>(databases.Count + 2);
                held.AddRange(databases.Values);
                if (server is not null) held.Add(server);
                if (agent is not null) held.Add(agent);
                return held;
            }
        }
    }

    /// <summary>Holds Agent's objects in place of those held before, as <see cref="PutServer"/>.</summary>
    public void PutAgent(DatabaseIndex value)
    {
        lock (gate)
        {
            if (Disposed) { Drop(value, value.Bytes - value.Credited); return; }
            Settle(agent, value);
            agent = value;
        }
    }

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
        var from = value.CreditFrom;
        value.Credit();
        if (old is not null && ReferenceEquals(old, from)) { Drop(old, old.Bytes - value.Credited); return; }
        if (old is not null) Drop(old, old.Bytes);
        if (value.Credited > 0) budget.Force(value.Credited);
    }

    private void Drop(DatabaseIndex value, long bytes)
    {
        value.Credit();
        budget.Release(bytes);
        value.Dropped(budget);
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

    /// <summary>Releases a freshly built read that was never placed in the index (e.g. superseded build), returning only the net bytes it took.</summary>
    public void Abandon(DatabaseIndex value) => Drop(value, value.Bytes - value.Credited);

    public void Put(DatabaseIndex value)
    {
        lock (gate)
        {
            if (Disposed) { Drop(value, value.Bytes - value.Credited); return; }
            databases.Remove(value.Key, out var old);
            Settle(old, value);
            databases[value.Key] = value;
        }
    }

    /// <summary>Drops the reads <paramref name="keep"/> refuses (a BigQuery listing's datasets and projects that are gone).</summary>
    public void KeepWhere(Func<DatabaseIndex, bool> keep)
    {
        lock (gate)
            foreach (var (key, value) in databases.Where(pair => !keep(pair.Value)).ToList())
                if (databases.Remove(key, out var old)) Drop(old, old.Bytes);
    }

    /// <summary>The read held under <paramref name="key"/> (<see cref="DatabaseIndex.Key"/>), or null.</summary>
    public DatabaseIndex? Get(string key)
    {
        lock (gate) return databases.GetValueOrDefault(key);
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
            if (agent is not null) Drop(agent, agent.Bytes);
            agent = null;
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
    /// <summary>Whether the regex is a Whole word pattern wrapped in one separator on each side, run over padded input.</summary>
    private readonly bool bounded;
    // Each search owns its matcher. Reuse the boundary buffer across its names and definitions.
    private char[] boundedInput = [];
    /// <summary>For a plain search, the longest run of its text without a dot or wildcard: a name the search can match with a
    /// dot must contain it, which spares building the qualified name of every object that cannot.</summary>
    private readonly string hint;

    private SearchMatcher(string text, bool caseSensitive, bool wholeWord, Regex? regex, bool plain, bool bounded = false)
    {
        this.text = text;
        hint = plain ? text.Split(['.', '*', '?']).MaxBy(part => part.Length) ?? "" : "";
        comparison = caseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
        this.wholeWord = wholeWord;
        this.regex = regex;
        this.bounded = bounded;
    }

    /// <summary>The matcher, or the reason the pattern cannot be one (a syntax error, or a construct NonBacktracking lacks).</summary>
    public static (SearchMatcher? Matcher, string? Problem) Create(string text, bool caseSensitive, bool wholeWord, bool regex, TimeSpan timeout)
    {
        var options = RegexOptions.NonBacktracking | RegexOptions.CultureInvariant | RegexOptions.Multiline | (caseSensitive ? RegexOptions.None : RegexOptions.IgnoreCase);
        if (!regex)
        {
            var literal = wholeWord ? text : text.Trim('*');
            if (literal.IndexOfAny(['*', '?']) < 0) return (new SearchMatcher(literal, caseSensitive, wholeWord, null, true), null);
            var pattern = Wildcard(literal);
            if (wholeWord)
            {
                // Only stars can match nothing. Whole Word requires a nonempty match.
                if (literal.All(c => c == '*')) pattern = @"[\p{L}\p{Nd}_@#$]+";
                pattern = Separator + pattern + Separator;
            }
            try { return (new SearchMatcher(literal, caseSensitive, wholeWord, new Regex(pattern, options, timeout), true, wholeWord), null); }
            catch (NotSupportedException) { return (null, "The wildcard pattern is too complex. Try a shorter pattern."); }
        }
        Regex own;
        try { own = new Regex(text, options, timeout); }
        catch (ArgumentException error) { return (null, Problem(error)); }
        catch (NotSupportedException) { return (null, "Regular expressions here cannot use lookarounds, backreferences, atomic groups or conditionals."); }
        // Checking each first match's neighbours would miss a longer whole-word match from the same start (Order.*?Id in
        // OrderIdArchiveId), so the separators go in the pattern. The pattern was checked alone above, so its offsets in any
        // error are the user's and the group cannot close early. \A, \z and \Z (and ^ or $ under (?-m)) cannot hold after a
        // consumed separator, and a (?x) comment can swallow the group's end: those keep the neighbour check.
        if (wholeWord && !TextAnchored(text))
        {
            try { return (new SearchMatcher(text, caseSensitive, wholeWord, new Regex(Separator + "(?:" + text + ")" + Separator, options, timeout), false, true), null); }
            catch (ArgumentException) { }
            catch (NotSupportedException) { }
        }
        return (new SearchMatcher(text, caseSensitive, wholeWord, own, false), null);
    }

    /// <summary>One character that is not an identifier character, compared exactly whatever the case option.</summary>
    private const string Separator = @"(?-i:[^\p{L}\p{Nd}_@#$])";

    /// <summary>Whether a pattern can name the ends of the whole input rather than of a line: \A, \z, \Z or \G, or an inline
    /// option that turns Multiline off, after which ^ and $ do. A false positive only keeps the neighbour check.</summary>
    internal static bool TextAnchored(string pattern)
    {
        for (var at = 0; at + 1 < pattern.Length; at++)
        {
            if (pattern[at] == '(' && pattern[at + 1] == '?')
            {
                var off = false;
                for (var option = at + 2; option < pattern.Length && pattern[option] is 'i' or 'm' or 'n' or 's' or 'x' or '-'; option++)
                {
                    if (pattern[option] == '-') off = true;
                    else if (off && pattern[option] == 'm') return true;
                }
                continue;
            }
            if (pattern[at] != '\\') continue;
            if (pattern[at + 1] is 'A' or 'z' or 'Z' or 'G') return true;
            at++;
        }
        return false;
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
    public bool Might(ObjectTable table, int at, string? database) =>
        hint.Length == 0 || Has(table.Name(at)) || Has(table.Schema(at)) || Has(table.ParentSchema(at)) || Has(table.ParentName(at)) || Has(database);

    private bool Has(string? value) => value is not null && value.Contains(hint, comparison);

    /// <summary>The first match at or after <paramref name="start"/>.</summary>
    public bool Find(ReadOnlySpan<char> value, int start, out int index, out int length) =>
        FindPrepared(Prepare(value), start, out index, out length);

    /// <summary>Whole-word patterns consume one separator on each side. Pad the true ends with line breaks, which keep ^ and $
    /// true there, so the same pattern works at any offset. The span is valid until the next Prepare on this query's matcher.</summary>
    internal ReadOnlySpan<char> Prepare(ReadOnlySpan<char> value)
    {
        if (!bounded) return value;
        var size = value.Length + 2;
        if (boundedInput.Length < size) boundedInput = new char[Math.Max(size, boundedInput.Length * 2)];
        var padded = boundedInput.AsSpan(0, size);
        padded[0] = padded[^1] = '\n';
        value.CopyTo(padded[1..]);
        return padded;
    }

    internal bool FindPrepared(ReadOnlySpan<char> value, int start, out int index, out int length)
    {
        if (bounded)
        {
            // In padded coordinates the preceding separator starts at the original match index. A regex can match nothing
            // between two separators, which Whole word does not count: look again from the next character.
            while (start <= value.Length - 2)
            {
                var matches = regex!.EnumerateMatches(value, start);
                if (!matches.MoveNext()) break;
                (index, length) = (matches.Current.Index, matches.Current.Length - 2);
                if (length > 0) return true;
                start = index + 1;
            }
            (index, length) = (-1, 0);
            return false;
        }
        while (start <= value.Length)
        {
            if (regex is not null)
            {
                // The first match at or after start, as Match(string, start) finds it (anchors and boundaries see the whole text).
                var matches = regex.EnumerateMatches(value, start);
                if (!matches.MoveNext()) break;
                (index, length) = (matches.Current.Index, matches.Current.Length);
            }
            else
            {
                var at = text.Length == 0 ? -1 : value[start..].IndexOf(text, comparison);
                if (at < 0) break;
                (index, length) = (start + at, text.Length);
            }
            if (!wholeWord || Bounded(value, index, length)) return true;
            start = index + Math.Max(1, length);
        }
        (index, length) = (-1, 0);
        return false;
    }

    private static bool Bounded(ReadOnlySpan<char> value, int index, int length) =>
        length > 0 && (index == 0 || !Word(value[index - 1])) && (index + length >= value.Length || !Word(value[index + length]));

    internal static bool Word(char value) => char.IsLetterOrDigit(value) || value is '_' or '@' or '#' or '$';
}

/// <summary>A process-wide sequence that orders reads and build outcomes for the lookup; the wall clock can step back.</summary>
internal static class IndexClock
{
    private static long now;

    public static long Next() => Interlocked.Increment(ref now);
}

/// <summary>What a search asks: its text and options, where to look, and how many hits to answer. Fuzzy adds approximate name
/// matches (<see cref="FuzzyName"/>) below the exact ones; it never applies to a regular expression or to definitions.</summary>
internal sealed record SearchQuery(string Text, bool CaseSensitive, bool WholeWord, bool Regex, bool Names, bool Definitions, IReadOnlySet<string>? Kinds, string? Database, int Limit,
    bool Fuzzy = false, string? Project = null, string? Dataset = null)
{
    /// <summary>The BigQuery kinds split by subtype, each a filter of its own (src/shared/explorer/search.ts bigQuerySearchTypes): a plain
    /// kind keeps only its shapes without one of these subtypes.</summary>
    public static readonly string[] Variants = ["bqTable:snapshot", "bqTable:clone", "bqRoutine:procedure", "bqRoutine:tableValued"];

    /// <summary>Whether the search's kinds keep objects of <paramref name="shape"/>: its kind:subtype variant when it has one, else its kind.</summary>
    public bool Keeps(ObjectShapes.Shape shape)
    {
        if (Kinds is null) return true;
        var variant = shape.Subtype is null ? null : shape.Kind + ":" + shape.Subtype;
        return variant is not null && Array.IndexOf(Variants, variant) >= 0 ? Kinds.Contains(variant) : Kinds.Contains(shape.Kind);
    }
}

/// <summary>Searches a connection's index. Names rank first (an exact name, then one that starts with the text, then any, then
/// under Fuzzy Match the approximate ones: every word found but apart, within edits, then by sound, each by fewest edits),
/// definition matches after them; within each, user objects before system ones, then by database, schema and name. The
/// resource database's objects are searched once, as master's (or the database the search names); the server's own objects
/// (which name no database) only by a search of the whole server.</summary>
internal static class IndexSearch
{
    /// <summary>The characters a scan unpacks before it checks its budget and Stop, however few objects that took: a few
    /// milliseconds of unpacking.</summary>
    internal const int CheckChars = 1 << 20;

    /// <summary>A hit as the scan finds it, before its result is built: its rank, the object and where its name matched (From is
    /// -1 when only its definition did, whose first match it then carries). The scan keeps at most the candidate cap of these;
    /// labels are built only for the kept ones, and results (match counts, previews, dates) only for the best `limit`.</summary>
    private readonly record struct Candidate(int Rank, int Score, string? Database, ObjectTable Table, int At, int From, int Length, bool Approximate, int DefinitionAt, int DefinitionLength,
        BigQueryFacts? Facts = null);

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
        // Long definitions are packed: each is unpacked into this search's own buffers as it is read.
        var scratch = new PackedText.Scratch();
        var databases = index.Databases.OrderBy(value => value.Database, StringComparer.OrdinalIgnoreCase).ThenBy(value => value.Dataset ?? "", StringComparer.OrdinalIgnoreCase).ToList();
        var sources = new List<(string? Database, ObjectTable Table, BigQueryFacts? Facts)>();
        if (query.Database is null && index.Server is { } server) sources.Add((null, server.Table, null));
        if (query.Database is null && index.Agent is { } agent) sources.Add((null, agent.Table, null));
        // A BigQuery search narrowed to a project or dataset keeps only its reads (a dataset's leaves out the project's own entry).
        sources.AddRange(databases.Where(value => (query.Database is null || string.Equals(value.Database, query.Database, StringComparison.Ordinal))
                && (query.Project is null || string.Equals(value.Database, query.Project, StringComparison.Ordinal))
                && (query.Dataset is null || string.Equals(value.Dataset, query.Dataset, StringComparison.Ordinal)))
            .Select(value => ((string?)value.Database, value.Table, value.Facts)));
        if (index.Resource is { } resource)
            sources.Add((query.Database ?? databases.FirstOrDefault(value => value.Database == "master")?.Database ?? databases.FirstOrDefault()?.Database ?? "master", resource.Table, null));
        foreach (var (name, table, facts) in sources)
        {
            // Which of the table's shapes the search's kinds keep, worked out once per table rather than once per object.
            var kept = query.Kinds is null ? null : table.Shapes.Select(query.Keeps).ToArray();
            for (var at = 0; at < table.Count; at++)
            {
                // The budget and Stop are checked by objects scanned, not hits found: a search with few hits still reads every
                // definition, and a superseded search must not keep scanning on the thread pool. Unpacking is the slow part of a
                // definition search, so a run of long packed definitions is checked sooner than every 64 objects.
                if ((++scanned & 63) == 0 || scratch.Unpacked >= CheckChars)
                {
                    scratch.Unpacked = 0;
                    token.ThrowIfCancellationRequested();
                    if (watch.Elapsed > limits.SearchBudget) { partial = true; goto done; }
                }
                if (kept is not null && !kept[table.ShapeOf(at)]) continue;
                if (!Match(name, table, at, query, matcher, fuzzy, dotted, scratch, out var candidate)) continue;
                if (facts is not null) candidate = candidate with { Facts = facts };
                total++;
                var key = (candidate.Rank, candidate.Score, table.System(at));
                if (found.Count < limits.Candidates) found.Enqueue(candidate, key);
                else
                {
                    partial = true;
                    if (found.TryPeek(out _, out var worst) && key.CompareTo(worst) < 0) found.DequeueEnqueue(candidate, key);
                }
            }
        }
    done:
        var best = found.UnorderedItems.Select(value => (Candidate: value.Element, Label: value.Element.Table.Label(value.Element.At)))
            .OrderBy(value => value.Candidate.Rank).ThenBy(value => value.Candidate.Score).ThenBy(value => value.Candidate.Table.System(value.Candidate.At))
            .ThenBy(value => value.Candidate.Database ?? "", StringComparer.OrdinalIgnoreCase)
            .ThenBy(value => value.Label, StringComparer.OrdinalIgnoreCase).ThenBy(value => value.Label, StringComparer.Ordinal)
            .Take(query.Limit);
        // Counting a hit's definition matches can read its whole definition up to MatchesCounted times, so the budget and Stop
        // bound this work too: past the budget the hits left are built only from what the scan found. Only a search the budget
        // actually left out makes the result partial: a hit with nothing left to search is as complete late as early.
        var hits = new List<ObjectSearchHit>(Math.Min(query.Limit, found.Count));
        var late = watch.Elapsed > limits.SearchBudget;
        var stopped = false;
        foreach (var (candidate, label) in best)
        {
            token.ThrowIfCancellationRequested();
            late = late || watch.Elapsed > limits.SearchBudget;
            hits.Add(Build(candidate, label, query, matcher, limits, watch, token, scratch, ref late, ref stopped));
        }
        return new(hits, total, partial || stopped, watch.ElapsedMilliseconds, status);
    }

    /// <summary>The rank of a hit only its definition matched.</summary>
    internal const int DefinitionRank = 6;

    /// <summary>Whether <paramref name="item"/> is a hit, with its rank and name range. Builds nothing for a name that matches
    /// without a dot; a definition is searched here only when the name did not match (the rank needs it), and a name hit's
    /// definition match waits for <see cref="Build"/>.</summary>
    private static bool Match(string? database, ObjectTable table, int at, SearchQuery query, SearchMatcher matcher, FuzzyName? fuzzy, bool dotted, PackedText.Scratch scratch,
        out Candidate candidate)
    {
        var rank = DefinitionRank;
        var score = 0;
        var approximate = false;
        var from = -1;
        var span = 0;
        if (query.Names)
        {
            var name = table.Name(at);
            var offset = table.LabelLength(at) - name.Length;
            if (matcher.Find(name, 0, out var index, out var length))
            {
                (from, span) = (offset + index, length);
                rank = length == name.Length ? 0 : index == 0 ? 1 : 2;
            }
            else if (dotted && query.Regex)
            {
                if (matcher.Find(table.Label(at), 0, out index, out length)) (from, span, rank) = (index, length, 2);
            }
            else if (dotted && matcher.Might(table, at, database))
            {
                // A plain search with a dot matches the qualified name between dots, so a dot marks where a part starts or
                // ends: .Sales finds the schema Sales and everything in it, Sales. too, and AppData.dbo.Orders the table in
                // that database. Only the label's part of the match is marked.
                var label = table.Label(at);
                var prefix = database is null ? 1 : database.Length + 2;
                if (matcher.Find(database is null ? "." + label + "." : "." + database + "." + label + ".", 0, out index, out length))
                {
                    var start = Math.Clamp(index - prefix, 0, label.Length);
                    var end = Math.Clamp(index + length - prefix, 0, label.Length);
                    (from, span) = (start, end - start);
                    rank = end == start ? 2 : start == 0 && end == label.Length ? 0 : start == 0 ? 1 : 2;
                }
            }
            if (from < 0 && fuzzy is not null && fuzzy.Match(name, table.Schema(at) ?? table.ParentSchema(at), table.ParentName(at), out var tier, out var cost, out var word, out var width))
            {
                (from, span) = (offset + word, width);
                (rank, score, approximate) = (3 + (int)tier, cost, true);
            }
        }
        var definitionAt = -1;
        var definitionLength = 0;
        if (from < 0 && !(query.Definitions && table.StoredDefinition(at) is { } stored && matcher.Find(DefinitionText.Read(stored, scratch), 0, out definitionAt, out definitionLength)))
        {
            candidate = default;
            return false;
        }
        candidate = new(rank, score, database, table, at, from, span, approximate, definitionAt, definitionLength);
        return true;
    }

    /// <summary>The result of a hit the search answers: its definition's match count and preview, its ref and its date. Once the
    /// search is <paramref name="late"/> (past its budget, which the count also checks) the definition is searched no further: a
    /// definition hit shows the match the scan found, its count only what was counted (marked Uncounted), and a name hit shows no
    /// definition match. <paramref name="stopped"/> is set only when lateness left out a search that would otherwise have run.</summary>
    private static ObjectSearchHit Build(Candidate hit, string label, SearchQuery query, SearchMatcher matcher, ObjectIndexLimits limits, Stopwatch watch, CancellationToken token,
        PackedText.Scratch scratch, ref bool late, ref bool stopped)
    {
        var (table, at) = (hit.Table, hit.At);
        DefinitionMatch? definition = null;
        var (first, size) = (hit.DefinitionAt, hit.DefinitionLength);
        var stored = table.StoredDefinition(at);
        var text = query.Definitions && stored is not null && !(first < 0 && late) ? DefinitionText.Read(stored, scratch) : default;
        var input = matcher.Prepare(text);
        if (query.Definitions && stored is not null && first < 0 && late) stopped = true;
        else if (query.Definitions && stored is not null && (first >= 0 || matcher.FindPrepared(input, 0, out first, out size)))
        {
            var count = 1;
            var next = first + Math.Max(1, size);
            for (; !late && count < limits.MatchesCounted && next <= text.Length && matcher.FindPrepared(input, next, out var again, out var width); count++)
            {
                next = again + Math.Max(1, width);
                token.ThrowIfCancellationRequested();
                late = watch.Elapsed > limits.SearchBudget;
            }
            // The loop ended on the budget alone, with more of the definition left to search: the count is only a lower bound. (From
            // the definition's very end only an empty regular expression match could follow, which is not worth a partial answer.)
            var uncounted = late && count < limits.MatchesCounted && next < text.Length;
            stopped |= uncounted;
            definition = Preview(text, first, size, count, limits.PreviewChars, table.DefinitionCut(at)) with { Uncounted = uncounted ? true : null };
        }
        var parent = table.Parent(at);
        var via = table.Via(at);
        var modified = table.Modified(at)?.ToString("yyyy-MM-ddTHH:mm:ss", System.Globalization.CultureInfo.InvariantCulture);
        int[]? range = hit.From < 0 ? null : [hit.From, hit.Length];
        if (BigQueryFacts.IsBigQuery(table.Kind(at)))
            return new(BigQueryFacts.RefOf(table, at, hit.Database!), table.Folder(at), label, range, modified, definition, table.Subtype(at), parent < 0 ? null : table.Folder(parent),
                Approximate: hit.Approximate ? true : null, Type: table.Kind(at) == "bqColumn" ? table.Typed(at)?.TypeName : null, Shards: hit.Facts?.Shards(at));
        var value = new ObjectRefDto(table.Kind(at), hit.Database, table.Schema(at), table.Name(at), parent < 0 ? null : new ParentRefDto(table.Kind(parent), table.Schema(parent)!, table.Name(parent)));
        return new(value, table.Folder(at), label, range, modified,
            definition, table.Subtype(at), parent < 0 ? null : table.Folder(parent), via >= 0 ? new ViaRefDto(table.Schema(via)!, table.Name(via), table.Folder(via)) : null, hit.Approximate ? true : null);
    }

    /// <summary>The match's line (1-based) and column, and up to <paramref name="chars"/> characters of that line around it.</summary>
    internal static DefinitionMatch Preview(ReadOnlySpan<char> text, int index, int length, int count, int chars, bool cut)
    {
        var line = 1;
        line += text[..index].Count('\n');
        var start = index == 0 ? 0 : text[..index].LastIndexOf('\n') + 1;
        var end = text[index..].IndexOf('\n');
        end = end < 0 ? text.Length : index + end;
        if (end > start && text[end - 1] == '\r') end--;
        // A match that spans lines shows up to its own line's end.
        var shown = Math.Min(length, Math.Max(0, end - index));
        var from = Math.Max(start, Math.Min(index - (chars - shown) / 3, end - chars));
        var to = Math.Min(end, Math.Max(from + chars, index + shown));
        if (to - from > chars) to = from + chars;
        from = Math.Max(start, from);
        var preview = new string(text[from..to]).Replace('\t', ' ');
        var highlightStart = Math.Clamp(index, from, to);
        var highlightEnd = Math.Clamp(index + shown, highlightStart, to);
        return new(line, index - start + 1, preview, [highlightStart - from, highlightEnd - highlightStart], from > start, to < end, count, cut);
    }
}
