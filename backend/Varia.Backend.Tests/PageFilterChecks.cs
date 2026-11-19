using System.Globalization;
using System.Text;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Page n-gram filters (PageFilter): Find over packed pages that passes over the pages their filters rule out finds
/// exactly what reading every page finds, in base order, through a filter and through a sort (read page by page), forward
/// and backward, typed a key at a time, across ordinal, ignore-case, CI_AS, CI_AI, CS_AS, Japanese, a culture without a fold
/// (Danish), GUIDs and binary; truncated cells keep the answer approximate; the ignore-case classes follow .NET; filters are
/// charged to the budget with their page and returned when it is unpacked or released.</summary>
internal static class PageFilterChecks
{
    // SqlCompareOptions: IgnoreCase 1, IgnoreNonSpace 2, IgnoreKanaType 8, IgnoreWidth 16, BinarySort2 16384.
    private static ResultCollation Collation(int lcid, int options) => new(lcid, 0, 1252, false, options);
    private const int CiAs = 1 | 8 | 16, CiAi = 1 | 2 | 8 | 16, CsAs = 8 | 16;

    private static readonly ResultColumn[] Columns =
    [
        new("id", "int", "text"),
        new("code", "varchar", "text", Collation: Collation(1033, 16384)),
        new("name", "nvarchar", "text", Collation: Collation(1033, CiAs)),
        new("plain", "nvarchar", "text", Collation: Collation(1033, CiAi)),
        new("exact", "nvarchar", "text", Collation: Collation(1033, CsAs)),
        new("japanese", "nvarchar", "text", Collation: Collation(1041, CiAs)),
        new("danish", "nvarchar", "text", Collation: Collation(1030, CiAs)),
        new("key", "uniqueidentifier", "text"),
        new("blob", "varbinary", "binary"),
        new("tone", "nvarchar", "text", Role: "tone", Collation: Collation(1033, CiAs)),
    ];
    private static readonly WireKind[] Wires = [.. Columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text)];
    private const int Key = 7, Blob = 8, Danish = 6;

    /// <summary>Words a block of rows draws its cells from: expansions, accents (composed and not), kana in both widths,
    /// ligatures, casing that ignore-case folds (ı, ſ, K), and plain identifiers.</summary>
    private static readonly string[] Words =
    [
        "Straße", "strasse", "STRASSE", "café", "café", "CAFÉ", "ﬁnance", "finance", "naïve", "œuvre", "oeuvre", "Æther", "aether",
        "サーバー", "ｻｰﾊﾞｰ", "さーばー", "データベース", "数据库", "Datenbank", "connexion", "ıstanbul", "İzmir", "ſtate", "Kelvin",
        "deadlock", "tempdb", "QUOTENAME", "replication", "permission", "columnstore", "FILESTREAM", "xp_cmdshell", "8152", "4060",
        "Ångström", "ångström", "Œdipe", "Ελληνικά", "ελληνικα", "Кириллица", "кириллица", "עברית", "عربي", "한국어", "日本語",
        "error", "table", "database", "order", "invoice", "customer", "warehouse", "shipment", "ledger", "balance",
    ];

    public static void Run(Action<bool, string> check)
    {
        foreach (var column in Columns)
            if (column.Collation is { } collation && ViewSorter.Culture(collation) is { } culture && Array.IndexOf(SearchFold.Verified, collation.Lcid) >= 0)
                SearchFold.Ready(collation.Lcid, culture.Options);
        Classes(check);
        Crafted(check);
        Differential(check, sets: 6, seed: 3);
        Typing(check);
        Budget(check);
    }

    /// <summary>The ignore-case classes are .NET's own: every code unit equals its class ignoring case, and two code units
    /// .NET finds equal share it.</summary>
    private static void Classes(Action<bool, string> check)
    {
        var all = Enumerable.Range(0, 65536).Where(c => !char.IsSurrogate((char)c)).Select(c => (char)c).ToArray();
        var classes = new char[all.Length];
        PageFilter.IgnoreCase(all, classes);
        var wrong = all.Where((c, i) => !string.Equals(c.ToString(), classes[i].ToString(), StringComparison.OrdinalIgnoreCase)).Take(3).ToList();
        char[] pairs = ['a', 'A', 'ı', 'I', 'ſ', 'S', 'K', 'k', 'é', 'É', 'ß', 'ẞ'];
        var mapped = new char[pairs.Length];
        PageFilter.IgnoreCase(pairs, mapped);
        var split = new List<string>();
        for (var i = 0; i < pairs.Length; i += 2)
            if (string.Equals(pairs[i].ToString(), pairs[i + 1].ToString(), StringComparison.OrdinalIgnoreCase) != (mapped[i] == mapped[i + 1])) split.Add(pairs[i] + "/" + pairs[i + 1]);
        check(wrong.Count == 0 && split.Count == 0, "each code unit's ignore-case class is one .NET finds equal to it, shared by the code units .NET finds equal: "
            + string.Join(",", wrong.Select(c => ((int)c).ToString("X4", CultureInfo.InvariantCulture))) + " " + string.Join(",", split));
    }

    /// <summary>A first page (64 rows) of cells that cannot hold the text, its first row truncated, then pages that all
    /// hold it: in base order the filtered first page keeps the answer approximate, as reading it would; through a view that
    /// leaves the truncated row out, the page is read and the answer is exact; the culture column's rule is the fold's, so a
    /// narrowed search after this one must meet it.</summary>
    private static void Crafted(Action<bool, string> check)
    {
        // Pages large enough that the first is sealed at its 64 rows, not by size.
        var store = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.EveryComplete, SealBytes = 64 * 1024, FilterMinBytes = 0 };
        var set = Open(store, "crafted");
        for (var r = 0; r < 400; r++)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            for (var c = 0; c < Columns.Length; c++)
            {
                if (c == 2) builder.AppendText(r < 64 ? "zzzz qqqq " + r : "hello world " + r, truncated: r == 0);
                else builder.AppendNull();
            }
            set.TryCommitRow();
        }
        set.Complete();
        var pages = set.SealedSnapshot();
        var baseWith = Shown(ResultSearcher.Search(set, pages, null, "hello", 0, false, 5, CancellationToken.None));
        var filtered = ResultSearcher.LastFiltered;
        var needs = set.SearchMemo?.Needs[2];
        var baseWithout = Shown(ResultSearcher.Search(set, pages, null, "hello", 0, false, 5, CancellationToken.None, narrow: false, filters: false));
        check(pages.Length >= 2 && pages[0].Rows == 64 && filtered == 1 && baseWith == baseWithout && baseWith.Contains("\"approximate\":true", StringComparison.Ordinal),
            "a filtered page holding a truncated cell keeps the answer approximate in base order: " + filtered + " " + baseWith);
        check(needs == SearchNarrowing.Needs.Fold, "cells a page filter ruled out in a culture column need the fold rule of a narrowed search after it: " + needs);
        var view = store.AddView(set, [.. Enumerable.Range(1, 399)], [], false, true, 0, null, 400);
        var viewWith = Shown(ResultSearcher.Search(set, pages, view, "hello", 0, false, 5, CancellationToken.None, narrow: false));
        var viewWithout = Shown(ResultSearcher.Search(set, pages, view, "hello", 0, false, 5, CancellationToken.None, narrow: false, filters: false));
        check(viewWith == viewWithout && viewWith.Contains("\"approximate\":false", StringComparison.Ordinal),
            "through a view that leaves the truncated row out, the page holding it is read and the answer is exact: " + viewWith);
        store.Release(set.ResultId);
    }

    private static ResultStore Store() => new(1L << 30, 1L << 29) { Packing = PagePacking.EveryComplete, SealBytes = 3 * 1024, FilterMinBytes = 0 };

    private static ResultSetBuffer Open(ResultStore store, string name) =>
        store.Open(store.BeginQuery(name), 0, 1, 1, "rows", Columns, Wires) ?? throw new InvalidOperationException("The result set was not kept.");

    /// <summary>Rows in blocks, each block drawing from a few words (so pages differ, as real results' do), each row filling
    /// a few columns; some cells truncated, some Danish (a culture without a fold, so its pages are always read).</summary>
    private static List<string?[]> Fill(ResultSetBuffer set, Random random, int rows)
    {
        var added = new List<string?[]>();
        string[] block = [];
        for (var r = 0; r < rows; r++)
        {
            if (r % 50 == 0) block = [.. Enumerable.Range(0, 5).Select(_ => Words[random.Next(Words.Length)])];
            var row = new string?[Columns.Length];
            byte[]? binary = null;
            var truncated = random.Next(40) == 0;
            row[0] = random.Next(100_000).ToString(CultureInfo.InvariantCulture);
            for (var c = 1; c < Columns.Length; c++)
            {
                if (random.Next(3) > 0 || c == Danish && random.Next(8) > 0) continue;
                if (c == Key) { var key = new Guid(Enumerable.Range(0, 16).Select(_ => (byte)random.Next(256)).ToArray()).ToString(); row[c] = random.Next(2) == 0 ? key.ToUpperInvariant() : key; }
                else if (c == Blob) { binary = [.. Enumerable.Range(0, random.Next(8) == 0 ? 128 + random.Next(100) : 1 + random.Next(6)).Select(_ => (byte)random.Next(256))]; row[c] = "0x" + Convert.ToHexString(binary); }
                else
                {
                    var text = new StringBuilder();
                    for (var k = 1 + random.Next(3); k > 0; k--) text.Append(block[random.Next(block.Length)]).Append(random.Next(3) == 0 ? "_" : " ");
                    row[c] = text.ToString().Trim();
                }
            }
            set.CountRow();
            var builder = set.BeginRow()!;
            for (var c = 0; c < Columns.Length; c++)
            {
                if (c == Blob) { if (binary is null) builder.AppendNull(); else builder.AppendBinary(binary, truncated); continue; }
                if (row[c] is { } value) builder.AppendText(value, truncated: truncated && c is 2 or 3); else builder.AppendNull();
            }
            set.TryCommitRow();
            added.Add(row);
        }
        return added;
    }

    /// <summary>Texts to search: pieces of cells (hits), their case, accent and width variants, hex and GUID pieces, and
    /// pieces of words no row holds.</summary>
    private static List<string> Texts(Random random, List<string?[]> rows, int count)
    {
        var texts = new List<string>();
        while (texts.Count < count)
        {
            var row = rows[random.Next(rows.Count)];
            var cell = row[1 + random.Next(Columns.Length - 2)];
            var pick = random.Next(6);
            if (pick == 0 || cell is null || cell.Length < 4) { var word = Words[random.Next(Words.Length)] + Words[random.Next(Words.Length)]; var at = random.Next(Math.Max(1, word.Length - 4)); texts.Add(word.Substring(at, Math.Min(word.Length - at, 4 + random.Next(5)))); continue; }
            var start = random.Next(cell.Length - 3);
            var piece = cell.Substring(start, Math.Min(cell.Length - start, 4 + random.Next(8)));
            texts.Add(pick switch
            {
                1 => piece.ToUpperInvariant(),
                2 => piece.Normalize(NormalizationForm.FormD),
                3 => piece.ToLowerInvariant().Replace('e', 'é'),
                _ => piece,
            });
        }
        return texts;
    }

    private static string Shown(SearchOutcome? outcome) => JsonSerializer.Serialize(outcome, HostChecks.Json);

    /// <summary>Every search with the filters finds what reading every page finds: base order, a filter that keeps every
    /// other block, and a shuffle (read page by page), forward from a row and backward to one.</summary>
    internal static void Differential(Action<bool, string> check, int sets, int seed)
    {
        var differences = new List<string>();
        long searches = 0, filtered = 0, approximate = 0;
        for (var s = 0; s < sets; s++)
        {
            var random = new Random(seed + s);
            var store = Store();
            var set = Open(store, "filters");
            var rows = Fill(set, random, 1200 + random.Next(800));
            set.Complete();
            var pages = set.SealedSnapshot();
            var count = (int)set.RowsAvailable;
            var kept = Enumerable.Range(0, count).Where(r => r / 50 % 2 == 0).ToArray();
            var shuffled = Enumerable.Range(0, count).OrderBy(_ => random.Next()).ToArray();
            ResultView?[] views = [null, store.AddView(set, kept, [], false, true, 0, null, count), store.AddView(set, shuffled, [], false, true, 0, null, count)];
            foreach (var text in Texts(random, rows, 60))
                foreach (var view in views)
                {
                    var from = random.Next(count);
                    var backward = random.Next(2) == 0;
                    var max = 1 + random.Next(30);
                    var with = Shown(ResultSearcher.Search(set, pages, view, text, from, backward, max, CancellationToken.None, narrow: false));
                    filtered += ResultSearcher.LastFiltered;
                    var without = Shown(ResultSearcher.Search(set, pages, view, text, from, backward, max, CancellationToken.None, narrow: false, filters: false));
                    searches++;
                    if (with.Contains("\"approximate\":true", StringComparison.Ordinal) && ResultSearcher.LastFiltered > 0) approximate++;
                    if (with != without) differences.Add(Escape(text) + (view is null ? " base" : " view") + ": " + with + " against " + without);
                }
            store.Release(set.ResultId);
        }
        check(differences.Count == 0 && filtered > 0, $"{searches} searches of packed pages through their filters ({filtered} pages passed over) find what reading every page finds: " + string.Join(" | ", differences.Take(2)));
        check(approximate > 0, "a page passed over that holds a truncated cell keeps the answer approximate (searches that passed pages over and were approximate: " + approximate + ")");
    }

    /// <summary>Typed a key at a time, narrowed (each key from the last) and through the filters, every key finds what a
    /// search of every row of every page finds.</summary>
    private static void Typing(Action<bool, string> check)
    {
        var differences = new List<string>();
        long filtered = 0;
        var random = new Random(17);
        var store = Store();
        var set = Open(store, "typing");
        var rows = Fill(set, random, 1500);
        set.Complete();
        var pages = set.SealedSnapshot();
        foreach (var word in Texts(random, rows, 40))
            for (var length = 1; length <= word.Length; length++)
            {
                var typed = word[..length];
                var with = Shown(ResultSearcher.Search(set, pages, null, typed, 0, false, 20, CancellationToken.None));
                filtered += ResultSearcher.LastFiltered;
                var without = Shown(ResultSearcher.Search(set, pages, null, typed, 0, false, 20, CancellationToken.None, narrow: false, filters: false));
                if (with != without) differences.Add(Escape(typed) + ": " + with + " against " + without);
            }
        store.Release(set.ResultId);
        check(differences.Count == 0 && filtered > 0, "typing narrowed and through page filters (" + filtered + " pages passed over) finds what a full search finds at every key: " + string.Join(" | ", differences.Take(2)));
    }

    /// <summary>A packed page is charged its bytes and its filter's; unpacking every page and releasing the result return
    /// them.</summary>
    private static void Budget(Action<bool, string> check)
    {
        // The same rows in a store that does not pack (also in the packed pass): the same pages, metadata and sidecars.
        var plainStore = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off, SealBytes = 3 * 1024, FilterMinBytes = 0 };
        var plain = Open(plainStore, "plain");
        Fill(plain, new Random(23), 900);
        plain.Complete();
        var store = Store();
        var set = Open(store, "budget");
        Fill(set, new Random(23), 900);
        set.Complete();
        var pages = set.SealedSnapshot();
        var raw = plain.SealedSnapshot();
        var filters = pages.Sum(page => page.Filter?.Bytes ?? 0);
        var others = store.UsedBytes - pages.Sum(page => page.StoredLength);
        var plainOthers = plainStore.UsedBytes - raw.Sum(page => (long)page.Length);
        check(filters > 0 && pages.Length == raw.Length && pages.All(page => page.Filter is null || page.StoredLength > page.Filter.Bytes) && others == plainOthers,
            "a packed page is charged its bytes and its filter's: " + filters + " filter bytes, " + others + " against " + plainOthers + " besides the pages");
        using (set.Pin())
        {
            var need = set.UnpackNeed();
            var reserved = set.TryReserveWork(need);
            if (reserved) set.UnpackAll(need);
            check(reserved && set.SealedSnapshot().All(page => page.Filter is null) && store.UsedBytes == plainStore.UsedBytes,
                "unpacking every page drops their filters and gives back their bytes: " + store.UsedBytes + " against " + plainStore.UsedBytes);
        }
        store.Release(set.ResultId);
        plainStore.Release(plain.ResultId);
        check(store.UsedBytes == 0, "a released result returns its pages' filters: " + store.UsedBytes);
    }

    private static string Escape(string text) => string.Concat(text.Select(c => c < 128 && !char.IsControl(c) ? c.ToString() : "\\u" + ((int)c).ToString("X4", CultureInfo.InvariantCulture)));
}
