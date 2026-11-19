using System.Globalization;
using System.Text;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Type-ahead narrowing (SearchNarrowing): Find in Results and the column filter's value search, typed a key at a
/// time, find exactly what a search of every row finds, for every keystroke, across ordinal, binary, CI_AS, CI_AI, CS_AS and
/// cultures that join letters (Czech, Danish, Albanian) or compare unusually (Japanese, Turkish), in base order, through a
/// sort and a filter, while a result still loads, packed and not. Narrowing happens where it may and not where it may not;
/// the cultures that join two ASCII characters are found from the collator; a search's memo is charged to the result's
/// budget, replaced by the next, and returned with the result.</summary>
internal static class SearchNarrowingChecks
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
        new("czech", "nvarchar", "text", Collation: Collation(1029, CiAs)),
        new("danish", "nvarchar", "text", Collation: Collation(1030, CiAs)),
        new("japanese", "nvarchar", "text", Collation: Collation(1041, CiAs)),
        new("turkish", "nvarchar", "text", Collation: Collation(1055, CiAi)),
        new("albanian", "nvarchar", "text", Collation: Collation(1052, CiAs)),
        new("blob", "varbinary", "binary"),
        new("tone", "nvarchar", "text", Role: "tone", Collation: Collation(1033, CiAs)),
    ];
    private static readonly WireKind[] Wires = [.. Columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text)];
    private const int Binary = 10;

    /// <summary>Words where the cultures above join letters or compare unusually, typed into the cells and the texts.</summary>
    private static readonly string[] Words =
    [
        "chata", "cesta", "Chrudim", "aabenraa", "Aalborg", "åben", "dhoma", "gjuha", "llamba", "nje", "ılık", "IŞIK", "istanbul", "İzmir",
        "café", "cafe", "CAFÉ", "Straße", "strasse", "œuvre", "ﬁnance", "naïve", "サーバー", "ｻｰﾊﾞｰ", "かな", "카페", "zz", "0xAB", "abc",
        "a\u0301b", "x\u200By", "soft\u00ADhyphen", "😀x", "dž", "lj", "cs", "csak", "ch", "c", "h", "a", "aa", "ab",
    ];

    public static void Run(Action<bool, string> check)
    {
        // The verified cultures' folds, built before typing starts, so the fuzz meets the pre-check tier from its first key.
        foreach (var column in Columns) if (column.Collation is { } collation && ViewSorter.Culture(collation) is { } culture && Array.IndexOf(SearchFold.Verified, collation.Lcid) >= 0) SearchFold.Ready(collation.Lcid, culture.Options);
        Cultures(check);
        Rules(check);
        Crafted(check);
        Typing(check, 4, 30, 700);
        Loading(check);
        Values(check);
        Memory(check);
    }

    /// <summary>The cultures that join two ASCII characters into one letter are found from the collator, not listed by hand.</summary>
    private static void Cultures(Action<bool, string> check)
    {
        var options = CompareOptions.IgnoreCase | CompareOptions.IgnoreKanaType | CompareOptions.IgnoreWidth;
        bool Safe(int lcid) => SearchNarrowing.SafeCulture(CultureInfo.GetCultureInfo(lcid).CompareInfo, options);
        int[] joining = [1029, 1051, 1052, 1106, 2074, 1030, 1044, 1038, 1050];
        int[] plain = [1033, 1031, 1036, 3082, 1063, 1041, 1055, 1049, 2052];
        check(joining.All(lcid => !Safe(lcid)) && plain.All(Safe) && !Safe(1054),
            "the cultures that join ASCII letters (Czech and Slovak ch, Albanian, Welsh, Serbian Latin, Danish, Norwegian, Hungarian, Croatian) and Thai never narrow; English, German, French, Spanish, Lithuanian, Japanese, Turkish, Russian and Chinese do: "
            + string.Join(",", joining.Where(Safe)) + " / " + string.Join(",", plain.Where(lcid => !Safe(lcid))));
    }

    /// <summary>When a text extends another: an ordinal substring anywhere, the same compare in every column, ASCII on both
    /// sides of a culture compare, no surrogate in the earlier text.</summary>
    private static void Rules(Action<bool, string> check)
    {
        SearchNarrowing.Kind O = SearchNarrowing.Kind.Ordinal, C = SearchNarrowing.Kind.Culture, N = SearchNarrowing.Kind.None, H = SearchNarrowing.Kind.Hex;
        // Culture columns here ruled cells out as ASCII; the fold cases below by the pre-check.
        bool E(string previous, SearchNarrowing.Kind[] before, string next, SearchNarrowing.Kind[] after) =>
            SearchNarrowing.Extends(previous, before, [.. before.Select(kind => kind == SearchNarrowing.Kind.Culture ? SearchNarrowing.Needs.Ascii : SearchNarrowing.Needs.None)],
                new string?[before.Length], next, after, new string?[after.Length]);
        SearchNarrowing.Needs F = SearchNarrowing.Needs.Fold;
        check(SearchNarrowing.Extends("caf", [C], [F], ["caf"], "café", [C], ["cafe"]) && !SearchNarrowing.Extends("cafe", [C], [F], ["cafe"], "cafe\u0301", [C], ["café"])
            && !SearchNarrowing.Extends("caf", [C], [F], [null], "cafe", [C], ["cafe"]) && SearchNarrowing.Extends("caf", [C], [SearchNarrowing.Needs.None], [null], "café", [C], [null])
            && !SearchNarrowing.Extends("caf", [C], [F | SearchNarrowing.Needs.Ascii], ["caf"], "café", [C], ["cafe"]),
            "cells ruled out by the pre-check narrow any text whose fold holds the earlier text's fold (an accent that composes with the last letter changes the fold), and no text without a fold; a column that ruled nothing out narrows any text; cells ruled out as ASCII need ASCII");
        check(E("abc", [O, C], "abcd", [O, C]) && E("abc", [O, C], "xabcd", [O, C]) && !E("abc", [O, C], "abd", [O, C]) && !E("abc", [O, C], "ab", [O, C]),
            "a text extends another that it holds anywhere, and no other");
        check(E("ab", [H, C], "abg", [N, C]) && !E("\u200B", [O], "\u200Ba", [C]),
            "a column that can no longer match needs nothing; a compare that changes kind (ignorable text was searched ordinally) never narrows");
        check(E("caf", [O], "café", [O]) && !E("caf", [C], "café", [C]) && !E("café", [C], "cafés", [C]) && !E("\uD83D", [O], "😀", [O]),
            "an ordinal column narrows any text; a culture column only ASCII text; an earlier text with a surrogate never narrows");
    }

    /// <summary>The cases that break a naive narrowing, each typed a key at a time into Find and a value search, over rows
    /// whose only cell is in the column the case is about (so no other cell makes the row searched again).</summary>
    private static void Crafted(Action<bool, string> check)
    {
        (int Column, string[] Cells, string[][] Sequences)[] cases =
        [
            (5, ["chata", "hrad", "Chrudim", "cesta"], [["c", "ch", "cha"], ["h", "hr"]]),
            (6, ["aabenraa", "Aalborg", "bad"], [["a", "aa", "aab"]]),
            (9, ["dhoma", "llamba", "doma", "lama"], [["d", "dh"], ["l", "ll"]]),
            (2, ["ß", "Straße", "ﬁ", "æ", "œ", "x"], [["s", "ss", "sse"], ["f", "fi"], ["a", "ae"], ["o", "oe"]]),
            (3, ["e\u0301", "a\u0301b", "naïve", "ﬀ"], [["e", "ee"], ["a", "ab"], ["n", "na", "nai"], ["f", "ff"]]),
            // Text of only ignorable characters (here an ASCII control character) is searched by code point.
            (2, ["cesta", "x\u0001y", "abc"], [["\u0001", "\u0001c", "\u0001ce"]]),
            (7, ["かな", "カナ", "kana"], [["k", "ka", "kan"]]),
        ];
        var differences = new List<string>();
        foreach (var (column, cells, sequences) in cases)
        {
            var store = new ResultStore(1L << 30, 1L << 29);
            var set = Open(store, "crafted");
            foreach (var cell in cells)
            {
                var row = new string?[Columns.Length - 1];
                row[column] = cell;
                Add(set, row, truncated: false, binary: null);
            }
            set.Complete();
            var snapshot = ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, column, true, CancellationToken.None);
            var reference = ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, column, true, CancellationToken.None);
            foreach (var sequence in sequences)
                foreach (var text in sequence)
                {
                    var narrowed = Shown(ResultSearcher.Search(set, set.SealedSnapshot(), null, text, 0, false, 100, CancellationToken.None));
                    var full = Shown(ResultSearcher.Search(set, set.SealedSnapshot(), null, text, 0, false, 100, CancellationToken.None, narrow: false));
                    if (narrowed != full) differences.Add(Columns[column].Name + " " + string.Join(">", sequence.Select(Escape)) + " at " + Escape(text) + ": " + narrowed + " against " + full);
                    var listed = Listed(snapshot.Read(DistinctOrder.Value, 0, 100, text, CancellationToken.None));
                    reference.ForgetSearch();
                    var all = Listed(reference.Read(DistinctOrder.Value, 0, 100, text, CancellationToken.None));
                    if (listed != all) differences.Add("values of " + Columns[column].Name + " at " + Escape(text) + ": " + listed + " against " + all);
                }
            store.Release(set.ResultId);
        }
        check(differences.Count == 0, "typing c, ch (Czech), a, aa (Danish), dh and ll (Albanian), ss, fi, ae and oe (expansions), after ignorable text and over kana finds and lists what a full search does: " + string.Join(" | ", differences.Take(3)));
    }

    /// <summary>Random typing sessions over random rows: every keystroke's search, narrowed, equals the full search.</summary>
    /// Half the sets are sparse: each row holds one text cell, so a row is searched again only for its own cell.
    internal static void Typing(Action<bool, string> check, int sets, int sessions, int rows, int seed = 7)
    {
        var differences = new List<string>();
        int steps = 0, extended = 0, repeated = 0;
        for (var s = 0; s < sets; s++)
        {
            var random = new Random(seed + s);
            var store = new ResultStore(1L << 30, 1L << 29);
            var set = Open(store, "typing" + s);
            var values = new List<string?[]>();
            for (var r = 0; r < rows; r++) values.Add(AddRandom(set, random, sparse: s >= sets / 2));
            set.Complete();
            if (s % 2 == 1) set.Pack();
            var pages = set.SealedSnapshot();
            var sorted = ViewSorter.Build(set, pages, [new ViewKey(2 + s % 8, s % 3 == 0, SortMode.Value)], [], CancellationToken.None).Order;
            var sort = store.AddView(set, sorted, [], false, true, 4L * sorted.Length, null, rows);
            var kept = Enumerable.Range(0, rows).Where(row => row % 3 != 1).ToArray();
            var filter = store.AddView(set, kept, [], false, true, 4L * kept.Length, null, rows);
            ResultView?[] views = [null, sort, filter];
            for (var session = 0; session < sessions; session++)
            {
                var view = views[random.Next(views.Length)];
                var target = Target(random, values);
                var text = "";
                for (var key = 0; key < target.Length + 3; key++)
                {
                    // Mostly the next character of the target; sometimes a key before it, a backspace, or Find Next again.
                    var move = random.Next(10);
                    if (move == 0 && text.Length > 1) text = text[..^1];
                    else if (move == 1) text = Words[random.Next(Words.Length)][..1] + text;
                    else if (move != 2 && key < target.Length) text += target[key];
                    if (text.Length == 0) continue;
                    var fromRow = move == 2 ? random.Next(rows) : 0;
                    var backward = move == 2 && random.Next(2) == 0;
                    var max = 1 + random.Next(move == 2 ? 50 : 500);
                    var narrowed = Shown(ResultSearcher.Search(set, pages, view, text, fromRow, backward, max, CancellationToken.None));
                    var how = ResultSearcher.LastNarrowing;
                    var full = Shown(ResultSearcher.Search(set, pages, view, text, fromRow, backward, max, CancellationToken.None, narrow: false));
                    steps++;
                    if (how == false) extended++;
                    else if (how == true) repeated++;
                    if (narrowed != full) differences.Add(Escape(text) + " (" + (how?.ToString() ?? "full") + ", view " + (view?.ViewId ?? 0) + "): " + narrowed + " against " + full);
                }
            }
        }
        check(differences.Count == 0 && extended > steps / 8 && repeated > steps / 50,
            "every keystroke of " + steps + " typed into Find (" + extended + " narrowed from a shorter text, " + repeated + " repeated) finds what a search of every row finds: "
            + string.Join(" | ", differences.Take(3)));
    }

    /// <summary>A result still loading: a narrowed search reads the rows sealed since the last one in full.</summary>
    private static void Loading(Action<bool, string> check)
    {
        var random = new Random(11);
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Open(store, "loading");
        var values = new List<string?[]>();
        var differences = new List<string>();
        var narrowedSteps = 0;
        var text = "";
        var target = "";
        for (var round = 0; round < 120; round++)
        {
            // Rows arrive (an odd number, so the memo ends mid-word) between every two keystrokes: each search after the
            // first of a word narrows from a memo over fewer rows, repeating its text or typing on.
            for (var r = 0; r < 13; r++) values.Add(AddRandom(set, random, sparse: true));
            set.Seal();
            if (text.Length >= target.Length) { target = Target(random, values); text = ""; }
            if (random.Next(3) > 0 || text.Length == 0) text += target[text.Length];
            var narrowed = Shown(ResultSearcher.Search(set, set.SealedSnapshot(), null, text, 0, false, 1000, CancellationToken.None));
            if (ResultSearcher.LastNarrowing is not null) narrowedSteps++;
            var full = Shown(ResultSearcher.Search(set, set.SealedSnapshot(), null, text, 0, false, 1000, CancellationToken.None, narrow: false));
            if (narrowed != full) differences.Add(round + " " + Escape(text) + ": " + narrowed + " against " + full);
        }
        set.Complete();
        check(differences.Count == 0 && narrowedSteps > 40, "while a result loads, a narrowed search finds what a full search finds, reading new rows in full: " + narrowedSteps + " narrowed; " + string.Join(" | ", differences.Take(3)));
    }

    /// <summary>The column filter's value search, typed a key at a time, lists what a fresh list's search lists, and narrows.</summary>
    private static void Values(Action<bool, string> check)
    {
        var differences = new List<string>();
        int narrowed = 0, steps = 0;
        var random = new Random(23);
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Open(store, "values");
        var values = new List<string?[]>();
        for (var r = 0; r < 2_000; r++) values.Add(AddRandom(set, random));
        set.Complete();
        foreach (var packed in new[] { false, true })
        {
            if (packed) set.Pack();
            for (var column = 1; column <= Binary; column++)
            {
                var snapshot = ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, column, true, CancellationToken.None);
                var reference = ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, column, true, CancellationToken.None);
                for (var session = 0; session < 12; session++)
                {
                    var target = column == Binary ? "0x" + Convert.ToHexString([(byte)random.Next(256)]) : Target(random, values, column);
                    var text = "";
                    for (var key = 0; key < target.Length; key++)
                    {
                        text = random.Next(8) == 0 && text.Length > 1 ? text[..^1] : text + target[key];
                        var read = snapshot.Read(DistinctOrder.Value, 0, ViewSorter.MaxDistinctWindow, text, CancellationToken.None);
                        if (snapshot.LastNarrowed) narrowed++;
                        reference.ForgetSearch();
                        var fresh = reference.Read(DistinctOrder.Value, 0, ViewSorter.MaxDistinctWindow, text, CancellationToken.None);
                        steps++;
                        var (a, b) = (Listed(read), Listed(fresh));
                        if (a != b) differences.Add(Columns[column].Name + " " + Escape(text) + ": " + a[..Math.Min(200, a.Length)] + " against " + b[..Math.Min(200, b.Length)]);
                    }
                }
            }
        }
        check(differences.Count == 0 && narrowed > steps / 4, "every keystroke of " + steps + " typed into the value search (" + narrowed + " narrowed) lists what a fresh list's search lists: " + string.Join(" | ", differences.Take(2)));
    }

    /// <summary>A search's memo is charged to the result's budget, replaced (its bytes returned) by the next search's,
    /// returned with the result, never taken without spare room, and never used through another view.</summary>
    private static void Memory(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Open(store, "memory");
        var random = new Random(5);
        for (var r = 0; r < 5_000; r++) AddRandom(set, random);
        set.Complete();
        var before = store.UsedBytes;
        ResultSearcher.Search(set, set.SealedSnapshot(), null, "e", 0, false, 10, CancellationToken.None);
        var memo = set.SearchMemo;
        var first = store.UsedBytes;
        ResultSearcher.Search(set, set.SealedSnapshot(), null, "es", 0, false, 10, CancellationToken.None);
        var narrowed = ResultSearcher.LastNarrowing;
        var second = store.UsedBytes;
        check(memo is { Text: "e", Rows: 5_000 } && first - before == memo.Bytes && memo.Bytes == SearchMemo.BytesFor(5_000, Columns.Length, 1) && narrowed == false
            && second - before == set.SearchMemo!.Bytes,
            "a search's memo (two bits a row) is charged to the result's budget and the next search's replaces it: " + before + " " + first + " " + second);
        var view = store.AddView(set, [.. Enumerable.Range(0, 5_000)], [], false, true, 20_000, null, 5_000);
        ResultSearcher.Search(set, set.SealedSnapshot(), view, "esx", 0, false, 10, CancellationToken.None);
        check(ResultSearcher.LastNarrowing is null && set.SearchMemo!.ViewId == view.ViewId, "a search through another view reads every row and keeps its own memo");
        ResultSearcher.Search(set, set.SealedSnapshot(), view, "es", 0, false, 10, CancellationToken.None);
        check(ResultSearcher.LastNarrowing is null, "a text that does not extend the last one reads every row");
        var held = store.UsedBytes;
        var memoBytes = set.SearchMemo!.Bytes;
        store.Release(set.ResultId);
        check(set.SearchMemo is null && held - store.UsedBytes >= memoBytes, "a released result returns its search's memo with it");

        // Little room: the memo is spare memory, so a search with no spare room keeps none and is still answered.
        var tight = new ResultStore(1L << 20, 1L << 20);
        var small = Open(tight, "tight");
        for (var r = 0; r < 500; r++) AddRandom(small, random);
        small.Complete();
        // Working memory to just short of the eighth spare memory must leave free: too little for a memo, room for a packed
        // page to be read.
        var taken = (1L << 20) * 7 / 8 - tight.UsedBytes - 64;
        var reserved = taken > 0 && small.TryReserveWork(taken);
        var found = ResultSearcher.Search(small, small.SealedSnapshot(), null, "e", 0, false, 10, CancellationToken.None);
        check(reserved && found is not null && small.SearchMemo is null, "without spare room a search keeps no memo and is still answered");
        small.ReturnWork(taken);

        // A cell the first text's pre-check ruled out is not read by the second, so the second's matcher records no rule
        // for it; the memo keeps the first's, or a third text would skip the cell under a rule nobody checked.
        var carry = Open(store, "carry");
        foreach (var cell in new[] { "xyz", "cafes" })
        {
            var row = new string?[Columns.Length - 1];
            row[2] = cell;
            Add(carry, row, truncated: false, binary: null);
        }
        carry.Complete();
        ResultSearcher.Search(carry, carry.SealedSnapshot(), null, "cafe", 0, false, 10, CancellationToken.None);
        var ruled = carry.SearchMemo!.Needs[2];
        ResultSearcher.Search(carry, carry.SealedSnapshot(), null, "cafes", 0, false, 10, CancellationToken.None);
        check(ruled == SearchNarrowing.Needs.Fold && ResultSearcher.LastNarrowing == false && carry.SearchMemo!.Needs[2] == SearchNarrowing.Needs.Fold,
            "a rule an earlier text ruled cells out by stays in the memo when a narrowed text rules nothing out itself: " + ruled + " " + carry.SearchMemo!.Needs[2]);
        var values = ViewSorter.DistinctValues(carry, carry.SealedSnapshot(), null, 2, true, CancellationToken.None);
        values.Read(DistinctOrder.Value, 0, 10, "cafe", CancellationToken.None);
        var valueRuled = values.LastNeeds;
        values.Read(DistinctOrder.Value, 0, 10, "cafes", CancellationToken.None);
        check(valueRuled == SearchNarrowing.Needs.Fold && values.LastNarrowed && values.LastNeeds == SearchNarrowing.Needs.Fold,
            "so does a value search's: " + valueRuled + " " + values.LastNeeds);
        store.Release(carry.ResultId);
    }

    private static ResultSetBuffer Open(ResultStore store, string name) =>
        store.Open(store.BeginQuery(name), 0, 1, 1, "rows", Columns, Wires) ?? throw new InvalidOperationException("The result set was not kept.");

    private static void Add(ResultSetBuffer set, string?[] row, bool truncated, byte[]? binary)
    {
        set.CountRow();
        var builder = set.BeginRow()!;
        for (var c = 0; c < Columns.Length; c++)
        {
            if (c == Binary) { if (binary is null) builder.AppendNull(); else builder.AppendBinary(binary); continue; }
            var text = c < Binary ? row[c] : row[c - 1];
            if (text is null) builder.AppendNull();
            else builder.AppendText(text, truncated: truncated && c == 2);
        }
        set.TryCommitRow();
    }

    /// <summary>Adds a random row (some NULLs, some truncated names); returns its text cells by column (the binary as hex).</summary>
    private static string?[] AddRandom(ResultSetBuffer set, Random random, bool sparse = false)
    {
        var row = new string?[Columns.Length];
        row[0] = random.Next(100_000).ToString(CultureInfo.InvariantCulture);
        var only = 1 + random.Next(Binary - 1);
        for (var c = 1; c < Columns.Length; c++) row[c] = c == Binary || (sparse && c != only) ? null : random.Next(10) == 0 ? null : Cell(random, sparse);
        var binary = sparse || random.Next(6) == 0 ? null : Enumerable.Range(0, 1 + random.Next(4)).Select(_ => (byte)random.Next(256)).ToArray();
        Add(set, [.. row[..Binary], row[Binary + 1]], truncated: random.Next(20) == 0, binary);
        if (binary is not null) row[Binary] = "0x" + Convert.ToHexString(binary);
        return row;
    }

    /// <summary>A random cell; a sparse one is mostly ASCII, so most rows are passed over rather than searched again.</summary>
    private static string Cell(Random random, bool sparse = false)
    {
        const string plain = "abcdefghijklmnopqrstuvwxyz0123456789 .-_";
        var text = new StringBuilder();
        for (var k = 1 + random.Next(6); k > 0; k--)
        {
            var pick = sparse && random.Next(3) > 0 ? 0 : random.Next(5);
            if (pick == 0) text.Append(plain[random.Next(plain.Length)]);
            else if (pick == 1) text.Append(Words[random.Next(Words.Length)]);
            else if (pick == 2) { var group = SearchFoldChecks.Groups[random.Next(SearchFoldChecks.Groups.Length)]; text.Append(group[random.Next(group.Length)]); }
            else if (pick == 3) { var sentence = SearchFoldChecks.Sentences[random.Next(SearchFoldChecks.Sentences.Length)]; var at = random.Next(sentence.Length - 8); text.Append(sentence, at, 4 + random.Next(5)); }
            else text.Append(Words[random.Next(Words.Length)].ToUpperInvariant());
        }
        return text.ToString();
    }

    /// <summary>A text to type: part of a cell (from one column when given), sometimes a word or a group member instead.</summary>
    private static string Target(Random random, List<string?[]> rows, int? column = null)
    {
        for (var tries = 0; tries < 20; tries++)
        {
            if (random.Next(5) == 0) return Words[random.Next(Words.Length)];
            var cell = rows[random.Next(rows.Count)][column ?? 1 + random.Next(Columns.Length - 1)];
            if (cell is not { Length: > 0 }) continue;
            var start = random.Next(cell.Length);
            return cell.Substring(start, Math.Min(cell.Length - start, 2 + random.Next(7)));
        }
        return "abc";
    }

    private static string Shown(SearchOutcome? outcome) => JsonSerializer.Serialize(outcome, HostChecks.Json);

    /// <summary>A value list read as text: its total and its values (a tuple has no properties to serialize).</summary>
    private static string Listed((int Total, DistinctValue[] Values, int Checked, bool NullChecked) read) =>
        read.Total + " " + JsonSerializer.Serialize(read.Values, HostChecks.Json);

    private static string Escape(string text) => string.Concat(text.Select(c => c < 128 && !char.IsControl(c) ? c.ToString() : "\\u" + ((int)c).ToString("X4", CultureInfo.InvariantCulture)));
}
