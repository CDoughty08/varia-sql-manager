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
        Searches(check);
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
        var packed = PackedText.Pack(text);
        var again = PackedText.Pack(text);
        check(packed.ToString() == text && packed.Length == text.Length && packed.ByteLength == Encoding.UTF8.GetByteCount(text),
            "a packed definition unpacks to its exact text (non-ASCII, a surrogate pair and CRLF included)");
        check(!ReferenceEquals(packed, again) && packed.Equals(again) && packed.GetHashCode() == again.GetHashCode() && !packed.Equals(PackedText.Pack(text + " ")),
            "the same text always packs to an equal frame, and a different one does not");
        check(packed.Bytes < IndexMemory.StringBytes(text.Length) / 4, "a packed module costs well under a quarter of its string: " + packed.Bytes + " against " + IndexMemory.StringBytes(text.Length));
        check(!PackedText.Packs(PackedText.MinChars - 1) && PackedText.Packs(PackedText.MinChars) && DefinitionText.Hold("((0))") is "((0))" && DefinitionText.Hold(text) is PackedText,
            "short definitions stay strings, long ones are packed");
        var scratch = new PackedText.Scratch();
        var other = Module("usp_Other", 200);
        var first = DefinitionText.Read(packed, scratch).ToString();
        var second = DefinitionText.Read(PackedText.Pack(other), scratch).ToString();
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
    private static SearchCostChecks.Batch Batch(params (string Name, string Text)[] procedures)
    {
        var at = DateTime.UnixEpoch;
        var ids = Enumerable.Range(0, procedures.Length).ToList();
        return new SearchCostChecks.Batch([
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime)), ("parent", typeof(int)),
                ("system", typeof(bool)), ("variant", typeof(byte)), ("current", typeof(int))], ids.Select(id => new object?[] { id + 1, "dbo", procedures[id].Name, "P", at, 0, false, (byte)0, null })),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("table", typeof(bool)), ("assembly", typeof(bool)), ("object", typeof(int))], []),
            Rows([("code", typeof(string)), ("schema", typeof(string)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], []),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], []),
            Rows([("name", typeof(string)), ("modified", typeof(DateTime)), ("text", typeof(string))], [["pg_long", at, Module("guide")]]),
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
        var sales = Read("Sales", ("usp_Shared", shared), ("usp_Own", own), ("usp_Short", "SELECT 1"));
        var archive = Read("Archive", ("usp_Shared", shared));
        index.Put(sales);
        index.Put(archive);
        int At(DatabaseIndex value, string name) => Enumerable.Range(0, value.Table.Count).Single(at => value.Table.Name(at) == name);
        var salesShared = sales.Table.StoredDefinition(At(sales, "usp_Shared"));
        check(salesShared is PackedText && sales.Table.StoredDefinition(At(sales, "usp_Short")) is "SELECT 1" && sales.Table.StoredDefinition(At(sales, "pg_long")) is PackedText,
            "a read holds long definitions (modules and plan guides) packed and short ones as strings");
        check(ReferenceEquals(salesShared, archive.Table.StoredDefinition(At(archive, "usp_Shared"))) && sales.Table.Definition(At(sales, "usp_Shared")) == shared
            && sales.Modules == 4 && sales.Cut == 0, "two databases with the same long definition hold one packed copy from the pool, which unpacks to the text");
        long Costs(params DatabaseIndex[] values) => values.Sum(value => value.Bytes) + values.SelectMany(value => value.Pooled).Distinct().Sum(value => StringPool.Cost(value));
        check(budget.Used == Costs(sales, archive), "the budget is charged each packed definition's frame once, with the names and short definitions");
        check(StringPool.Cost(salesShared!) < StringPool.Cost(shared) / 3, "a packed definition costs the budget a fraction of its string");
        index.Put(Read("Archive", ("usp_Shared", shared + "-- changed")));
        check(ReferenceEquals(sales.Table.StoredDefinition(At(sales, "usp_Shared")), salesShared) && pool.Count == sales.Pooled.Length + 1,
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
            new("procedure", "storedProcedures", "dbo", "needle_proc", Definition: Module("needle_proc", 10)),
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
        check(packed.Databases.Single().Table.StoredDefinition(0) is PackedText && strings.Databases.Single().Table.StoredDefinition(0) is string,
            "the comparison really holds one index packed and the other as strings");
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
            (@"needle again$", true, false, false, false), ("Orders", false, false, false, true), ("END", false, true, true, false), ("nothing here", false, false, false, false)
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
            "a regular expression anchored at line starts counts each line's match in a packed definition (matching resumes at a position, not a substring)");
    }
}
