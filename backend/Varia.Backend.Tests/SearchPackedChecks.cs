using System.Data;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of packed definitions (<see cref="PackedText"/>): a long definition is held as one zstd frame that
/// unpacks to the same text, equal frames share one pool entry across databases, the budget is charged the frame rather than the
/// string, and a search finds, counts and previews matches in a packed definition exactly as in the string it replaced.</summary>
internal static class SearchPackedChecks
{
    private static readonly ObjectIndexStatus Ready = new("ready", 1, 1, 0, 0, 0, [], true);

    public static void Run(Action<bool, string> check)
    {
        Texts(check);
        Reads(check).GetAwaiter().GetResult();
        Refused(check);
        Resources(check).GetAwaiter().GetResult();
        Searches(check);
        Stops(check);
        Matching(check);
        Previews(check);
    }

    /// <summary>A module long enough to be packed: <paramref name="lines"/> lines, the needle on some of them, non-ASCII text and a
    /// character outside the BMP so the UTF-8 round trip is exercised.</summary>
    private static string Module(string name, int lines = 60)
    {
        var text = new StringBuilder("CREATE PROCEDURE dbo." + name + "\r\nAS\r\nBEGIN\r\n");
        for (var line = 0; line < lines; line++)
            text.Append(line % 7 == 3 ? "\tSELECT needle, N'Café 😀 Ünïcode' FROM dbo.Orders WHERE id = " + line + "; -- needle again\r\n" : "\tSET @total = @total + " + line + ";\r\n");
        return text.Append("END\r\n").ToString();
    }

    private static void Texts(Action<bool, string> check)
    {
        var text = Module("usp_Packed");
        var packed = PackedText.TryPack(text)!;
        var again = PackedText.TryPack(text)!;
        check(packed.ToString() == text && packed.Length == text.Length && packed.ByteLength == Encoding.UTF8.GetByteCount(text),
            "a packed definition unpacks to its exact text (non-ASCII, a surrogate pair and CRLF included)");
        check(!ReferenceEquals(packed, again) && packed.Equals(again) && packed.GetHashCode() == again.GetHashCode() && !packed.Equals(PackedText.TryPack(text + " ")),
            "the same text always packs to an equal frame, and a different one does not");
        check(packed.Bytes < IndexMemory.StringBytes(text.Length) / 4, "a packed module costs well under a quarter of its string: " + packed.Bytes + " against " + IndexMemory.StringBytes(text.Length));
        check(PackedText.TryPack(new string('x', PackedText.MinChars - 1)) is null && PackedText.TryPack(new string('x', PackedText.MinChars)) is { Length: PackedText.MinChars }
            && DefinitionText.Hold("((0))") is "((0))" && DefinitionText.Hold(text) is PackedText, "short definitions stay strings, long ones are packed");
        // nvarchar holds unpaired surrogates, and the per-module cut can split a pair: UTF-8 would turn either into U+FFFD.
        var cutPair = Module("usp_Cut") + "\uD83D";
        var lowAlone = Module("usp_Low") + "\uDE00 tail";
        check(PackedText.TryPack(cutPair) is null && PackedText.TryPack(lowAlone) is null && DefinitionText.Hold(cutPair) is string held && held == cutPair,
            "a long text with an unpaired surrogate stays the exact string, not a frame that would unpack to U+FFFD");
        var scratch = new PackedText.Scratch();
        var other = Module("usp_Other", 200);
        var first = DefinitionText.Read(packed, scratch).ToString();
        var second = DefinitionText.Read(PackedText.TryPack(other)!, scratch).ToString();
        check(first == text && second == other && DefinitionText.Read(packed, scratch).SequenceEqual(text), "one search's buffers unpack definitions of any length, one after another");
    }

    private static DataTable Rows((string Name, Type Type)[] columns, IEnumerable<object?[]> rows)
    {
        var table = new DataTable();
        foreach (var (name, type) in columns) table.Columns.Add(name, type);
        foreach (var row in rows) table.Rows.Add([.. row.Select(value => value ?? DBNull.Value)]);
        return table;
    }

    /// <summary>A database batch without children and with definitions: procedures with the given definitions, a long plan guide.</summary>
    private static SearchCostChecks.Batch Batch(params (string Name, string Text)[] procedures) => Guided(Module("guide"), procedures);

    /// <summary>A database batch as <see cref="Batch"/>, with <paramref name="guide"/> as its plan guide's text.</summary>
    private static SearchCostChecks.Batch Guided(string guide, params (string Name, string Text)[] procedures)
    {
        var at = DateTime.UnixEpoch;
        var ids = Enumerable.Range(0, procedures.Length).ToList();
        return new SearchCostChecks.Batch([
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime)), ("parent", typeof(int)),
                ("system", typeof(bool)), ("variant", typeof(byte)), ("current", typeof(int))], ids.Select(id => new object?[] { id + 1, "dbo", procedures[id].Name, "P", at, 0, false, (byte)0, null })),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("table", typeof(bool)), ("assembly", typeof(bool)), ("object", typeof(int))], []),
            Rows([("code", typeof(string)), ("schema", typeof(string)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], []),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], []),
            Rows([("name", typeof(string)), ("modified", typeof(DateTime)), ("text", typeof(string))], [["pg_long", at, guide]]),
            Rows([("id", typeof(int)), ("text", typeof(string))], ids.Select(id => new object?[] { id + 1, procedures[id].Text }))
        ]);
    }

    private static async Task Reads(Action<bool, string> check)
    {
        var budget = new IndexBudget(1L << 30);
        var pool = new StringPool(budget);
        var index = new ConnectionIndex(budget, pool: pool);
        var shared = Module("usp_Shared");
        var own = Module("usp_Own", 90);
        DatabaseIndex Read(string database, params (string, string)[] procedures) =>
            new DatabaseReader(database, new ObjectIndexLimits(), pool).ReadAsync(Batch(procedures), true, CancellationToken.None, children: false).GetAwaiter().GetResult()!;
        var lone = Module("usp_Lone") + "\uD83D";
        var sales = Read("Sales", ("usp_Shared", shared), ("usp_Own", own), ("usp_Short", "SELECT 1"), ("usp_Lone", lone));
        var archiveOnly = Module("usp_ArchiveOnly");
        var archive = Read("Archive", ("usp_Shared", shared), ("usp_ArchiveOnly", archiveOnly));
        index.Put(sales);
        index.Put(archive);
        int At(DatabaseIndex value, string name) => Enumerable.Range(0, value.Table.Count).Single(at => value.Table.Name(at) == name);
        var salesShared = sales.Table.StoredDefinition(At(sales, "usp_Shared"));
        check(salesShared is PackedText && sales.Table.StoredDefinition(At(sales, "usp_Short")) is "SELECT 1" && sales.Table.StoredDefinition(At(sales, "pg_long")) is PackedText,
            "a read holds long definitions (modules and plan guides) packed and short ones as strings");
        check(sales.Table.StoredDefinition(At(sales, "usp_Lone")) is string loneHeld && loneHeld == lone, "a read keeps a long definition with an unpaired surrogate as its exact string");
        check(ReferenceEquals(salesShared, archive.Table.StoredDefinition(At(archive, "usp_Shared"))) && sales.Table.Definition(At(sales, "usp_Shared")) == shared
            && sales.Modules == 5 && sales.Cut == 0, "two databases with the same long definition hold one packed copy from the pool, which unpacks to the text");
        long Costs(params DatabaseIndex[] values) => values.Sum(value => value.Bytes) + values.SelectMany(value => value.Pooled).Distinct().Sum(value => StringPool.Cost(value));
        check(budget.Used == Costs(sales, archive), "the budget is charged each packed definition's frame once, with the names and short definitions");
        check(StringPool.Cost(salesShared!) < StringPool.Cost(shared) / 3, "a packed definition costs the budget a fraction of its string");
        var replaced = Read("Archive", ("usp_Shared", shared + "-- changed"));
        index.Put(replaced);
        check(ReferenceEquals(sales.Table.StoredDefinition(At(sales, "usp_Shared")), salesShared) && pool.Count == sales.Pooled.Concat(replaced.Pooled).Distinct().Count()
            && !sales.Pooled.Concat(replaced.Pooled).Any(value => value is PackedText packed && packed.ToString() == archiveOnly) && budget.Used == Costs(sales, replaced),
            "replacing one database keeps the packed text another still holds and gives back what only it held");
        index.Dispose();
        check(budget.Used == 0 && pool.Count == 0, "a disconnect gives every packed definition back");
    }

    /// <summary>The same rows as one table whose long definitions are packed (as a read holds them) and one that holds every
    /// definition as a string, as the index did before definitions were packed.</summary>
    private static (ConnectionIndex Packed, ConnectionIndex Strings) Indexes()
    {
        IndexedObject[] rows =
        [
            new("procedure", "storedProcedures", "dbo", "usp_A", Definition: Module("usp_A")),
            new("procedure", "storedProcedures", "dbo", "usp_B", Definition: Module("usp_B", 400)),
            new("procedure", "storedProcedures", "dbo", "needle_proc", Definition: Module("needle_proc")),
            new("procedure", "storedProcedures", "dbo", "usp_Lone", Definition: Module("usp_Lone") + "\uD83D"),
            new("view", "views", "dbo", "v_short", Definition: "SELECT needle FROM dbo.Orders"),
            new("table", "tables", "dbo", "Orders")
        ];
        var builder = new ObjectTable.Builder();
        foreach (var row in rows)
        {
            builder.Text(row.Name);
            builder.Text(row.Schema!);
            if (row.Definition is { } definition) builder.Text(definition);
        }
        foreach (var row in rows)
        {
            var at = builder.Add(row);
            if (row.Definition is { } definition) builder.SetDefinition(at, definition, false);
        }
        var budget = new IndexBudget(long.MaxValue);
        var packed = new ConnectionIndex(budget);
        packed.Put(new DatabaseIndex("Sales", rows, 0, 0, 0));
        var strings = new ConnectionIndex(budget);
        strings.Put(new DatabaseIndex("Sales", builder.Build(), 0, 0, 0));
        return (packed, strings);
    }

    private static void Searches(Action<bool, string> check)
    {
        var (packed, strings) = Indexes();
        var table = packed.Databases.Single().Table;
        check(table.StoredDefinition(0) is PackedText && table.StoredDefinition(2) is PackedText && table.StoredDefinition(3) is string
            && strings.Databases.Single().Table.StoredDefinition(0) is string, "the comparison really holds one index packed and the other as strings");
        var limits = new ObjectIndexLimits { SearchBudget = TimeSpan.FromMinutes(1) };
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        string Run(ConnectionIndex index, string text, bool regex = false, bool wholeWord = false, bool caseSensitive = false, bool names = true)
        {
            var (matcher, problem) = SearchMatcher.Create(text, caseSensitive, wholeWord, regex, TimeSpan.FromSeconds(2));
            var result = IndexSearch.Run(index, new(text, caseSensitive, wholeWord, regex, names, true, null, null, 200), matcher!, limits, Ready, CancellationToken.None);
            return problem ?? JsonSerializer.Serialize(result.Hits, options) + "|" + result.Total + "|" + result.Partial;
        }
        (string Text, bool Regex, bool WholeWord, bool Case, bool Names)[] queries =
        [
            ("needle", false, false, false, true), ("needle", false, false, false, false), ("NEEDLE", false, false, true, false), ("needle", false, true, false, false),
            ("ne?dle", false, false, false, false), ("Café 😀", false, false, false, false), (@"^\s*SELECT needle", true, false, false, false), (@"id = \d+;", true, false, false, false),
            (@"needle again$", true, false, false, false), ("Orders", false, false, false, true), ("END", false, true, true, false), ("nothing here", false, false, false, false),
            ("needle_proc", false, false, false, true), ("\uFFFD", false, false, false, false), (@"[\uD800-\uDBFF]", true, false, false, false)
        ];
        var differ = queries.Where(query => Run(packed, query.Text, query.Regex, query.WholeWord, query.Case, query.Names) != Run(strings, query.Text, query.Regex, query.WholeWord, query.Case, query.Names))
            .Select(query => query.Text).ToList();
        check(differ.Count == 0, "a search over packed definitions answers exactly what it answered over strings (hits, ranges, counts, previews): " + string.Join(", ", differ));

        // The match count and the preview's line and column come from the unpacked text.
        var long_ = Module("usp_B", 400);
        var (count, matcher2) = (Regex.Matches(long_, "needle").Count, SearchMatcher.Create("needle", false, false, false, TimeSpan.FromSeconds(2)).Matcher!);
        var hit = IndexSearch.Run(packed, new("needle", false, false, false, false, true, null, null, 200), matcher2, limits, Ready, CancellationToken.None).Hits.Single(value => value.Object.Name == "usp_B");
        var first = long_.IndexOf("needle", StringComparison.Ordinal);
        var line = long_[..first].Count(value => value == '\n') + 1;
        check(hit.Definition is { } definition && definition.Matches == count && definition.Line == line && definition.Preview.Contains("needle", StringComparison.Ordinal),
            "a packed definition's hit counts every match and previews the first one's line: " + hit.Definition?.Matches + " of " + count + ", line " + hit.Definition?.Line + " of " + line);
        var anchored = IndexSearch.Run(packed, new(@"^\s*SELECT", false, false, true, false, true, null, null, 200), SearchMatcher.Create(@"^\s*SELECT", false, false, true, TimeSpan.FromSeconds(2)).Matcher!,
            limits, Ready, CancellationToken.None).Hits.Single(value => value.Object.Name == "usp_B");
        check(anchored.Definition?.Matches == Regex.Matches(long_, @"^\s*SELECT", RegexOptions.Multiline | RegexOptions.IgnoreCase).Count,
            "a regular expression anchored at line starts counts each line's match in a packed definition");
    }

    /// <summary>A read with room past the names' reserve, but not for a long definition's frame and slot, refuses it: the pool
    /// refuses the frame (or the slot charge fails after it, and the frame is given back), the refusal is counted as cut, and what
    /// the read kept is charged exactly. The room a definition needs to be held grows by exactly its frame's cost, so the
    /// refusals below it are the frame's and the slot's, not the reserve's short-text path.</summary>
    private static void Refused(Action<bool, string> check)
    {
        var limits = new ObjectIndexLimits();
        var small = Module("guide");
        var large = Module("guide", 240);
        // What the read charges without definitions (names, records), measured on a budget that refuses nothing.
        var free = new IndexBudget(1L << 40);
        _ = new DatabaseReader("Sales", limits, new StringPool(free)).ReadAsync(Guided(small), false, CancellationToken.None, children: false).GetAwaiter().GetResult();
        var names = free.Used;
        (DatabaseIndex Read, IndexBudget Budget, StringPool Pool) Read(string guide, long room)
        {
            var budget = new IndexBudget(limits.NamesReserveBytes + names + room);
            var pool = new StringPool(budget);
            return (new DatabaseReader("Sales", limits, pool).ReadAsync(Guided(guide), true, CancellationToken.None, children: false).GetAwaiter().GetResult()!, budget, pool);
        }
        // The least room that holds the guide's definition.
        long Least(string guide)
        {
            var (low, high) = (0L, 1L << 20);
            while (low < high)
            {
                var middle = (low + high) / 2;
                if (Read(guide, middle).Read.Table.StoredDefinition(0) is PackedText) high = middle; else low = middle + 1;
            }
            return low;
        }
        var (smallPacked, largePacked) = (PackedText.TryPack(small)!, PackedText.TryPack(large)!);
        var (smallRoom, largeRoom) = (Least(small), Least(large));
        check(largePacked.Bytes > smallPacked.Bytes && largeRoom - smallRoom == StringPool.Cost(largePacked) - StringPool.Cost(smallPacked) && smallRoom > IndexMemory.SlotBytes,
            "the room a long definition needs grows by exactly its frame's pool cost: " + smallRoom + " and " + largeRoom + " for frames costing " + StringPool.Cost(smallPacked) + " and " + StringPool.Cost(largePacked));
        foreach (var (room, held, name) in new (long, bool, string)[]
        {
            (smallRoom - IndexMemory.SlotBytes - 1, false, "the pool refuses a frame past the reserve"),
            (smallRoom - 1, false, "the slot charge fails after the frame is acquired"),
            (smallRoom, true, "room for the frame and its slot holds it packed")
        })
        {
            var (read, budget, pool) = Read(small, room);
            var stored = read.Table.StoredDefinition(0);
            check(held ? stored is PackedText && stored.Equals(smallPacked) && read.Cut == 0 && read.Modules == 1 : stored is null && read.Cut == 1 && read.Modules == 0,
                name + ": " + (stored?.GetType().Name ?? "nothing") + " held, " + read.Cut + " cut");
            check(budget.Used == read.Bytes + read.Pooled.Sum(StringPool.Cost) && pool.Count == read.Pooled.Length,
                name + ", and the budget is charged only what the read kept");
            var index = new ConnectionIndex(budget, pool: pool);
            index.Put(read);
            index.Dispose();
            check(budget.Used == 0 && pool.Count == 0, name + ", and a disconnect gives all of it back: " + budget.Used + " bytes, " + pool.Count + " texts");
        }
    }

    /// <summary>A scan of long packed definitions checks Stop after about <see cref="IndexSearch.CheckChars"/> characters, not only
    /// every 64 objects: a stopped search over three such definitions stops, though it never reaches 64 objects.</summary>
    private static void Stops(Action<bool, string> check)
    {
        var body = new StringBuilder("CREATE PROCEDURE dbo.usp_Huge AS\r\n");
        for (var line = 0; body.Length < IndexSearch.CheckChars * 3 / 5; line++) body.Append("SELECT ").Append(line).Append(" AS value;\r\n");
        var index = new ConnectionIndex(new IndexBudget(long.MaxValue));
        index.Put(new DatabaseIndex("Sales", [.. Enumerable.Range(0, 3).Select(at => new IndexedObject("procedure", "storedProcedures", "dbo", "usp_Huge" + at, Definition: body + "-- " + at))], 0, 0, 0));
        check(index.Databases.Single().Table.StoredDefinition(0) is PackedText, "the stop check's definitions are packed");
        var matcher = SearchMatcher.Create("never_written", false, false, false, TimeSpan.FromSeconds(2)).Matcher!;
        var query = new SearchQuery("never_written", false, false, false, false, true, null, null, 200);
        var limits = new ObjectIndexLimits { SearchBudget = TimeSpan.FromMinutes(1) };
        check(IndexSearch.Run(index, query, matcher, limits, Ready, CancellationToken.None).Hits.Count == 0, "a search of the huge definitions finds nothing");
        try
        {
            IndexSearch.Run(index, query, matcher, limits, Ready, new CancellationToken(true));
            check(false, "a stopped search over a few long packed definitions stops before it reaches 64 objects");
        }
        catch (OperationCanceledException) { check(true, "a stopped search over a few long packed definitions stops before it reaches 64 objects"); }
    }

    /// <summary>The preview of a match, as the string-based code before definitions were packed built it (its line, column, text
    /// and highlighted range).</summary>
    private static DefinitionMatch OldPreview(string text, int index, int length, int count, int chars, bool cut)
    {
        var line = 1;
        for (var at = text.IndexOf('\n'); at >= 0 && at < index; at = text.IndexOf('\n', at + 1)) line++;
        var start = index == 0 ? 0 : text.LastIndexOf('\n', index - 1) + 1;
        var end = text.IndexOf('\n', index);
        if (end < 0) end = text.Length;
        if (end > start && text[end - 1] == '\r') end--;
        var shown = Math.Min(length, Math.Max(0, end - index));
        var from = Math.Max(start, Math.Min(index - (chars - shown) / 3, end - chars));
        var to = Math.Min(end, Math.Max(from + chars, index + shown));
        if (to - from > chars) to = from + chars;
        from = Math.Max(start, from);
        var preview = text[from..to].Replace('\t', ' ');
        return new(line, index - start + 1, preview, [index - from, Math.Min(shown, to - index)], from > start, to < end, count, cut);
    }

    private static void Previews(Action<bool, string> check)
    {
        string[] texts = ["SELECT a\r\nFROM b\r\n\r\nWHERE c = 1\n", "\tone\tline with tabs and no newline at all, long enough to be cut on both sides of a match", "\n\n\r\n", "x", Module("usp_Preview", 12)];
        var differ = new List<string>();
        for (var which = 0; which < texts.Length; which++)
        {
            var text = texts[which];
            foreach (var chars in new[] { 1, 8, 40, 200 })
                for (var index = 0; index <= text.Length; index++)
                    foreach (var length in new[] { 0, 1, 5, 30 })
                    {
                        if (index + length > text.Length) continue;
                        var now = IndexSearch.Preview(text.AsSpan(), index, length, 3, chars, false);
                        var then = OldPreview(text, index, length, 3, chars, false);
                        if (now.Line != then.Line || now.Column != then.Column || now.Preview != then.Preview || !now.Range.SequenceEqual(then.Range) || now.Before != then.Before || now.After != then.After)
                            differ.Add(which + ":" + index + "+" + length + "/" + chars);
                    }
        }
        check(differ.Count == 0, "a preview built from the unpacked text matches the string-based preview line, column, text and range for every position: " + string.Join(", ", differ.Take(10)));
    }

    /// <summary>System objects' sets (<see cref="ResourceCatalog"/>) hold long definitions packed and share them between builds.</summary>
    private static async Task Resources(Action<bool, string> check)
    {
        var budget = new IndexBudget(1L << 30);
        var pool = new StringPool(budget);
        var catalog = new ResourceCatalog(pool);
        var same = Module("sp_same");
        ObjectTable Objects(string second) => ObjectTable.Of([
            new IndexedObject("procedure", "systemStoredProcedures", "sys", "sp_same", Definition: same, System: true),
            new IndexedObject("procedure", "systemStoredProcedures", "sys", "sp_other", Definition: second, System: true)]);
        var key = new ResourceKey("16.0.4135.4", 3, 2, DateTime.UnixEpoch, 42, true);
        var first = await catalog.AcquireAsync(key, _ => Task.FromResult(Objects(Module("sp_other"))));
        var other = await catalog.AcquireAsync(key with { Version = "16.0.4140.3", Checksum = 7 }, _ => Task.FromResult(Objects("SELECT 2")));
        check(first.Table.StoredDefinition(0) is PackedText && ReferenceEquals(first.Table.StoredDefinition(0), other.Table.StoredDefinition(0))
            && other.Table.StoredDefinition(1) is "SELECT 2" && first.Modules == 2 && other.Modules == 2 && first.Table.Definition(0) == same,
            "two builds' system object sets hold a long definition they share as one packed copy");
        catalog.Release(first);
        check(pool.Count == 5 && other.Table.Definition(0) == same, "letting one set go keeps the packed text the other holds");
        catalog.Release(other);
        check(catalog.Sets == 0 && pool.Count == 0 && budget.Used == 0, "with no set left, every packed system definition is given back");
    }

    /// <summary>The span matcher finds what the string calls it replaced found (Regex.Match(string, start), string.IndexOf from a
    /// start), from every start: anchors, boundaries, empty matches, Whole Word and ordinal case folding included.</summary>
    private static void Matching(Action<bool, string> check)
    {
        string[] texts =
        [
            "SELECT a\r\nFROM b\r\n\r\nWHERE c = 1\n", "ab_ab ab@ab ab#ab ab$ab ab ab", "Straße STRASSE ıİ i I K K k", "line\n\nline\r\n$end^", "",
            "x😀y 😀 z", "needle needle_proc proc_needle needle"
        ];
        (string Pattern, bool Regex, bool WholeWord, bool Case)[] matchers =
        [
            ("^", true, false, false), ("$", true, false, false), (@"^\s*\w+", true, false, false), (@"\b\w", true, false, false), (@"\B", true, false, false),
            (@"\Z", true, false, false), (@"\A.", true, false, false), (@"(?s).", true, false, false), ("^$", true, false, false), ("ab", true, true, false),
            ("ab", false, true, false), ("AB", false, false, true), ("ab", false, false, false), ("strasse", false, false, false), ("i", false, false, false),
            ("k", false, false, false), ("needle", false, true, false), ("ne?dle", false, false, false), ("😀", false, false, false), ("line*", false, false, false)
        ];
        var options = RegexOptions.NonBacktracking | RegexOptions.CultureInvariant | RegexOptions.Multiline;
        var differ = new List<string>();
        foreach (var (pattern, regex, wholeWord, caseSensitive) in matchers)
        {
            var matcher = SearchMatcher.Create(pattern, caseSensitive, wholeWord, regex, TimeSpan.FromSeconds(2)).Matcher!;
            var plain = wholeWord ? pattern : pattern.Trim('*');
            var literal = !regex && plain.IndexOfAny(['*', '?']) < 0 ? plain : null;
            var reference = literal is null ? new Regex(regex ? pattern : SearchMatcher.Wildcard(plain), options | (caseSensitive ? RegexOptions.None : RegexOptions.IgnoreCase)) : null;
            for (var which = 0; which < texts.Length; which++)
            {
                var text = texts[which];
                for (var start = 0; start <= text.Length; start++)
                {
                    var (index, length) = (-1, 0);
                    for (var from = start; from <= text.Length;)
                    {
                        int at, width;
                        if (reference is not null)
                        {
                            var match = reference.Match(text, from);
                            if (!match.Success) break;
                            (at, width) = (match.Index, match.Length);
                        }
                        else
                        {
                            at = literal!.Length == 0 ? -1 : text.IndexOf(literal, from, caseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase);
                            if (at < 0) break;
                            width = literal.Length;
                        }
                        if (!wholeWord || width > 0 && (at == 0 || !SearchMatcher.Word(text[at - 1])) && (at + width >= text.Length || !SearchMatcher.Word(text[at + width]))) { (index, length) = (at, width); break; }
                        from = at + Math.Max(1, width);
                    }
                    if (matcher.Find(text.AsSpan(), start, out var found, out var size) != index >= 0 || found != index || size != length) differ.Add(pattern + "@" + start + " in text " + which);
                }
            }
        }
        check(differ.Count == 0, "the span matcher finds the same first match from every start as the string calls it replaced: " + string.Join(", ", differ.Take(10)));
    }
}
