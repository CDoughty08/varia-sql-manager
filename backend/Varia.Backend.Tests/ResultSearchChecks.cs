using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Search in results (results.search): matches by each column's collation, NULL never matching, binary values by
/// their hex, runs of whole rows forward and backward with the count before them, searches through a view, and the
/// request's limits.</summary>
internal static class ResultSearchChecks
{
    // Latin1_General_CI_AI (IgnoreCase, IgnoreNonSpace, IgnoreKanaType, IgnoreWidth), Latin1_General_BIN2, Latin1_General_CS_AS.
    private static readonly ResultCollation CaseAccentInsensitive = new(1033, 0, 1252, false, 1 | 2 | 8 | 16);
    private static readonly ResultCollation Bin2 = new(1033, 0, 1252, false, 16384);
    private static readonly ResultCollation CaseSensitive = new(1033, 0, 1252, false, 8 | 16);

    private static readonly ResultColumn[] Columns =
    [
        new("id", "int", "text"), new("name", "nvarchar", "text", Collation: CaseAccentInsensitive), new("code", "varchar", "text", Collation: Bin2),
        new("blob", "varbinary", "binary"), new("note", "nvarchar", "text", Collation: CaseSensitive)
    ];
    private static readonly WireKind[] Wires = [.. Columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text)];

    /// <summary>Rows: id, name, code, blob, note (null for NULL); the last row's note is stored truncated.</summary>
    private static readonly object?[][] Rows =
    [
        ["1", "Café", "Abc", new byte[] { 0xAB, 0x01 }, "x"],
        ["12", "cafe", "abc", new byte[] { 0x01 }, null],
        ["3", "CAFÉ ", "ABC", null, "abcabc"],
        [null, null, "zz", new byte[] { 0xCA, 0xFE }, "Cafe"],
        ["21", "tea", "aBc", new byte[] { 0xAB }, "abc"],
        [null, null, null, null, "zzz"]
    ];

    public static void Run(Action<bool, string> check)
    {
        Matching(check);
        Runs(check);
        Dispatch(check);
        Large(check);
        Stopping(check);
        Bounded(check);
        Edges(check);
        DiffTone(check);
    }

    private static ResultSetBuffer Fill(ResultStore store)
    {
        var set = store.Open(store.BeginQuery("search"), 0, 1, 1, "rows", Columns, Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        for (var r = 0; r < Rows.Length; r++)
        {
            var row = Rows[r];
            set.CountRow();
            var builder = set.BeginRow()!;
            for (var c = 0; c < row.Length; c++)
            {
                if (row[c] is null) builder.AppendNull();
                else if (row[c] is byte[] bytes) builder.AppendBinary(bytes);
                else builder.AppendText((string)row[c]!, truncated: r == Rows.Length - 1);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static SearchOutcome Find(ResultSetBuffer set, string text, long fromRow = 0, bool backward = false, int max = ResultSearcher.MaxMatches, ResultView? view = null) =>
        ResultSearcher.Search(set, set.SealedSnapshot(), view, text, fromRow, backward, max, CancellationToken.None)!;

    private static string Show(SearchOutcome found) => string.Join(",", found.Rows.Zip(found.Columns).Select(pair => pair.First + ":" + pair.Second));

    private static void Matching(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store);
        var cafe = Find(set, "cafe");
        check(Show(cafe) == "0:1,1:1,2:1,3:3" && cafe.Total == 4 && cafe.First == 0 && cafe.Searched == 6,
            "a _CI_AI column matches any case and accent, a _CS_AS one only the same case, and a binary value its 0x hex, ignoring case (" + Show(cafe) + ")");
        var abc = Find(set, "abc");
        check(Show(abc) == "1:2,2:4,4:4", "a _BIN2 column matches by code point and a _CS_AS one by case (" + Show(abc) + ")");
        var one = Find(set, "1");
        check(Show(one) == "0:0,0:3,1:0,1:3,4:0" && one.Approximate,
            "a number matches its display text, binary values their hex digits, NULL never, and a truncated value searched by its prefix makes the outcome approximate (" + Show(one) + ")");
        check(Find(set, "NULL").Total == 0 && Find(set, "0x").Total == 4 && Find(set, "0XCA").Total == 1 && Find(set, "zzz") is { Total: 1, Approximate: false },
            "NULL cells are never matched, binary values match 0x as the grid shows it, and a truncated value that matches leaves the outcome exact");
        check(Find(set, "q").Total == 0 && Find(set, "é").Total == 4, "text no cell contains finds nothing; an accented letter matches the plain one in an accent-insensitive column (tea), not in an accent-sensitive one");
        var cancelled = false;
        try { ResultSearcher.Search(set, set.SealedSnapshot(), null, "a", 0, false, 10, new CancellationToken(canceled: true)); }
        catch (OperationCanceledException) { cancelled = true; }
        check(cancelled, "a Stop ends a search");
    }

    private static void Runs(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store);
        var head = Find(set, "1", 0, false, 2);
        var next = Find(set, "1", 1, false, 2);
        var tail = Find(set, "1", 2, false, 2);
        check(Show(head) == "0:0,0:3" && head.First == 0 && Show(next) == "1:0,1:3" && next.First == 2 && Show(tail) == "4:0" && tail.First == 4 && tail.Total == 5,
            "a forward run starts at its row and ends with the row that reaches its size, saying how many matches come before it");
        var back = Find(set, "1", 6, true, 2);
        var start = Find(set, "1", 1, true, 1);
        var none = Find(set, "1", 0, true, 5);
        check(Show(back) == "1:0,1:3,4:0" && back.First == 2 && Show(start) == "0:0,0:3" && start.First == 0 && none.Rows.Length == 0 && none.First == 0,
            "a backward run holds the last whole rows before its row that reach its size");
        var past = Find(set, "1", 5, false, 10);
        check(past.Rows.Length == 0 && past.First == 5 && past.Total == 5, "a forward run past every match is empty, with every match before it");
        var order = ViewSorter.Sort(set, set.SealedSnapshot(), [new ViewKey(0, true, SortMode.Value)], CancellationToken.None).Order;
        var view = store.AddView(set, order, [new ViewKey(0, true, SortMode.Value)], false, true, 0, null);
        var viewed = Find(set, "1", view: view);
        check(Show(viewed) == "0:0,1:0,1:3,3:0,3:3", "a search through a view counts view positions, in its order (" + Show(viewed) + ")");
    }

    private static void Dispatch(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Fill(store);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        string? Code(object args)
        {
            try { Call<object>("results.search", args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var before = store.UsedBytes;
        var found = Call<ResultsSearchResult>("results.search", new { resultId = set.ResultId, text = "cafe", fromRow = 0, maxMatches = 100 });
        check(SqlService.MethodNames.Contains("results.search") && found.Total == 4 && found.MatchRows.SequenceEqual([0L, 1, 2, 3]) && found.MatchColumns.SequenceEqual([1, 1, 1, 3])
            && found.Complete && found.Approximate && found.Rows == 6 && store.UsedBytes == before, "results.search answers the matches of a result and holds no memory after it");
        var view = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        var viewed = Call<ResultsSearchResult>("results.search", new { resultId = set.ResultId, text = "1", fromRow = 1, maxMatches = 2, viewId = view.ViewId });
        check(viewed.MatchRows.SequenceEqual([1L, 1]) && viewed.First == 1 && viewed.Total == 5, "results.search searches through a view by its positions");
        var codes = new[]
        {
            Code(new { resultId = set.ResultId, text = "", fromRow = 0, maxMatches = 1 }),
            Code(new { resultId = set.ResultId, text = new string('a', ResultSearcher.MaxText + 1), fromRow = 0, maxMatches = 1 }),
            Code(new { resultId = set.ResultId, text = "a", fromRow = -1, maxMatches = 1 }),
            Code(new { resultId = set.ResultId, text = "a", fromRow = 0, maxMatches = 0 }),
            Code(new { resultId = set.ResultId, text = "a", fromRow = 0, maxMatches = ResultSearcher.MaxMatches + 1 }),
            Code(new { resultId = set.ResultId, text = "a", fromRow = 0, maxMatches = 1, viewId = 0 }),
            Code(new { resultId = set.ResultId, text = "a", fromRow = 0, maxMatches = 1, extra = 1 }),
            Code(new { resultId = 999, text = "a", fromRow = 0, maxMatches = 1 }),
            Code(new { resultId = set.ResultId, text = "a", fromRow = 0, maxMatches = 1, viewId = 12345 })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,RESULT_NOT_FOUND,VIEW_NOT_FOUND",
            "results.search needs 1 to 1,024 characters, a row from 0, 1 to 10,000 matches and a view of the result: " + string.Join(",", codes));
        store.Release(set.ResultId);
        check(Code(new { resultId = set.ResultId, text = "a", fromRow = 0, maxMatches = 1 }) == "RESULT_RELEASED", "a released result's search answers RESULT_RELEASED");
    }

    /// <summary>Runs over many pages: a forward run stops at its size, a backward one keeps only the last rows.</summary>
    private static void Large(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = store.Open(store.BeginQuery("many"), 0, 1, 1, "rows", [new("name", "varchar", "text")], [WireKind.Text])!;
        const int count = 30_000;
        for (var row = 0; row < count; row++)
        {
            set.CountRow();
            set.BeginRow()!.AppendText(row % 3 == 0 ? "match" : "other");
            set.TryCommitRow();
        }
        set.Complete();
        var forward = Find(set, "match");
        var backward = Find(set, "match", count, true, 3);
        check(forward.Total == count / 3 && forward.Rows.Length == ResultSearcher.MaxMatches && forward.Rows[^1] == 3L * (ResultSearcher.MaxMatches - 1)
            && backward.Rows.SequenceEqual([count - 9L, count - 6, count - 3]) && backward.First == count / 3 - 3,
            "over many pages a forward run stops at 10,000 matches, and a backward one keeps the last rows before its row");
        // A view in reverse order reads its rows from every page, last page first (Source's binary search through a view).
        var reversed = Enumerable.Range(0, count).Select(row => count - 1 - row).ToArray();
        var view = store.AddView(set, reversed, [new ViewKey(0, true, SortMode.Value)], false, true, 0, null);
        var viewed = Find(set, "match", view: view);
        var viewedBack = Find(set, "match", count, true, 3, view);
        check(set.SealedSnapshot().Length > 2 && viewed.Total == count / 3 && viewed.Rows[0] == 2 && viewed.Rows[^1] == 3L * (ResultSearcher.MaxMatches - 1) + 2
            && viewedBack.Rows.SequenceEqual([count - 7L, count - 4, count - 1]) && viewedBack.First == count / 3 - 3,
            "a search through a view over many pages finds each row's matches at its view position, forward and backward");
    }

    /// <summary>A result of columns filled from rows of cells (null for NULL, byte[] for binary), with the cells
    /// <paramref name="truncated"/> names stored truncated.</summary>
    private static ResultSetBuffer Build(ResultStore store, ResultColumn[] columns, IEnumerable<object?[]> rows, Func<int, int, bool>? truncated = null)
    {
        var wires = columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text).ToArray();
        var set = store.Open(store.BeginQuery("search"), 0, 1, 1, "rows", columns, wires) ?? throw new InvalidOperationException("The result set was not kept.");
        var r = 0;
        foreach (var row in rows)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            for (var c = 0; c < row.Length; c++)
            {
                var cut = truncated?.Invoke(r, c) == true;
                if (row[c] is null) builder.AppendNull();
                else if (row[c] is byte[] bytes) builder.AppendBinary(bytes, cut);
                else builder.AppendText((string)row[c]!, cut);
            }
            set.TryCommitRow();
            r++;
        }
        set.Complete();
        return set;
    }

    private static ResultSetBuffer Matches(ResultStore store, int count) =>
        Build(store, [new("name", "varchar", "text")], Enumerable.Range(0, count).Select(_ => new object?[] { "match" }));

    /// <summary>A release or a view's close during a search stops it at its next checkpoint with no outcome (#350, #353),
    /// and checkpoints come per work done, not per 1,024 rows (#352).</summary>
    private static void Stopping(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        const int count = 30_000;
        var set = Matches(store, count);
        var stopped = ResultSearcher.Stopped(store, set, null);
        var calls = 0;
        var released = ResultSearcher.Search(set, set.SealedSnapshot(), null, "match", 0, false, 10, CancellationToken.None, () =>
        {
            if (++calls == 2) store.Release(set.ResultId);
            return stopped();
        });
        check(released is null && calls == 2, "a result released during a search stops it at the next checkpoint, with no outcome (" + calls + " checkpoints)");

        var viewed = Matches(store, count);
        var view = store.AddView(viewed, Enumerable.Range(0, count).ToArray(), [new ViewKey(0, false, SortMode.Value)], false, true, 0, null);
        var viewStopped = ResultSearcher.Stopped(store, viewed, view);
        calls = 0;
        var closed = ResultSearcher.Search(viewed, viewed.SealedSnapshot(), view, "match", 0, false, 10, CancellationToken.None, () =>
        {
            if (++calls == 2) store.CloseViews(viewed.ResultId, [view.ViewId]);
            return viewStopped();
        });
        check(closed is null && calls == 2, "a view closed during a search through it stops the search at the next checkpoint, with no outcome");

        // A release between FindView and the snapshot empties it: no outcome, not an IndexOutOfRangeException.
        var raced = Matches(store, 10);
        var racedView = store.AddView(raced, Enumerable.Range(0, 10).ToArray(), [new ViewKey(0, false, SortMode.Value)], false, true, 0, null);
        store.Release(raced.ResultId);
        SearchOutcome? empty = null;
        var threw = false;
        try { empty = ResultSearcher.Search(raced, raced.SealedSnapshot(), racedView, "match", 0, false, 10, CancellationToken.None); }
        catch (Exception) { threw = true; }
        check(!threw && empty is null && raced.SealedSnapshot().Length == 0, "a view search over a snapshot emptied by a release answers no outcome rather than failing");

        // Wide rows check at least once per row, and so do long values, not once per 1,024 rows.
        const int wide = 4096;
        var wideSet = Build(store, [.. Enumerable.Range(0, wide).Select(c => new ResultColumn("c" + c, "varchar", "text"))],
            Enumerable.Range(0, 8).Select(_ => Enumerable.Repeat<object?>("abcdefgh", wide).ToArray()));
        calls = 0;
        ResultSearcher.Search(wideSet, wideSet.SealedSnapshot(), null, "zz", 0, false, 10, CancellationToken.None, () => { calls++; return false; });
        var longCalls = 0;
        var longSet = Build(store, [new("doc", "nvarchar", "text")], Enumerable.Range(0, 4).Select(_ => new object?[] { new string('x', ResultSearcher.CheckEvery) }));
        ResultSearcher.Search(longSet, longSet.SealedSnapshot(), null, "zz", 0, false, 10, CancellationToken.None, () => { longCalls++; return false; });
        check(calls >= 8 && longCalls >= 4, "a search of wide or long-valued rows reaches a checkpoint at least once per row (" + calls + ", " + longCalls + ")");
    }

    /// <summary>Parsed page layouts are bounded: one in base order, LayoutCacheBytes through a view (#351).</summary>
    private static void Bounded(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        const int wide = 4096, count = 120;
        var set = Build(store, [.. Enumerable.Range(0, wide).Select(c => new ResultColumn("c" + c, "varchar", "text"))],
            Enumerable.Range(0, count).Select(_ => Enumerable.Repeat<object?>("v", wide).ToArray()));
        var pages = set.SealedSnapshot();
        var layout = 4L * PageView.ScratchLength(wide);
        var baseOrder = new ResultSearcher.Source(pages, wide, 1);
        for (var row = 0; row < count; row++) baseOrder.ViewOf(row, out _);
        var viewOrder = new ResultSearcher.Source(pages, wide, (int)(ResultSearcher.LayoutCacheBytes / layout));
        for (var row = count - 1; row >= 0; row--) viewOrder.ViewOf(row, out _);
        check(pages.Length > ResultSearcher.LayoutCacheBytes / layout + 1 && baseOrder.LayoutBytes == layout && viewOrder.LayoutBytes <= ResultSearcher.LayoutCacheBytes,
            "a search of a wide result keeps one page layout in base order and at most 1 MiB of them through a view (" + pages.Length + " pages, "
            + baseOrder.LayoutBytes + ", " + viewOrder.LayoutBytes + " bytes)");
        var reversed = Enumerable.Range(0, count).Select(row => count - 1 - row).ToArray();
        var view = store.AddView(set, reversed, [new ViewKey(0, true, SortMode.Value)], false, true, 0, null);
        var found = Find(set, "v", 0, false, 3 * wide, view);
        check(found.Total == (long)wide * count && found.Rows.Length == 3 * wide && found.Rows[^1] == 2, "a search through a view of a wide result reads its rows through the bounded layouts");
    }

    /// <summary>Ignorable text (#354), an unknown locale, an oversized backward row and a truncated binary column (#356).</summary>
    private static void Edges(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store);
        check(Find(set, "​").Total == 0 && Find(set, "­").Total == 0 && Find(set, "​cafe").Total == 3,
            "text of only ignorable characters is looked for as written, matching no cell, while ignorables beside other text stay ignored (the hex column skips it)");
        var withSpace = Build(store, [new("name", "nvarchar", "text", Collation: CaseAccentInsensitive)], [["a​b"], ["ab"]]);
        check(Show(Find(withSpace, "​")) == "0:0", "a cell holding an ignorable character is found by it");

        var unknown = new ResultCollation(0x7F7F, 0, 1252, false, 1 | 2);
        var local = Build(store, [new("name", "nvarchar", "text", Collation: unknown)], [["Café"], ["CAFE"], ["cafe"]]);
        check(ViewSorter.Culture(unknown) is null && Show(Find(local, "cafe")) == "1:0,2:0",
            "a locale this runtime does not know compares by its case flag alone, not its accent flag (" + Show(Find(local, "cafe")) + ")");

        var all = Build(store, [new("a", "varchar", "text"), new("b", "varchar", "text"), new("c", "varchar", "text")], Enumerable.Range(0, 3).Select(_ => new object?[] { "a", "a", "a" }));
        var back = Find(all, "a", 3, true, 2);
        var forward = Find(all, "a", 0, false, 2);
        check(Show(back) == "2:0,2:1,2:2" && back.First == 6 && back.Total == 9 && Show(forward) == "0:0,0:1,0:2" && forward.First == 0,
            "a run whose one row holds more matches than its size keeps that whole row, backward and forward");

        var binary = Build(store, [new("blob", "varbinary", "binary"), new("note", "varchar", "text")], [[new byte[] { 0xAB, 0xCD }, "x"]], (_, column) => column == 0);
        check(Find(binary, "q") is { Total: 0, Approximate: false } && Find(binary, "ab") is { Total: 1, Approximate: false } && Find(binary, "ef") is { Total: 0, Approximate: true },
            "a truncated binary cell is skipped for text that is not hex, leaving the outcome exact, and searched by its prefix for hex");
    }

    /// <summary>A diff result's hidden tone column (its "added 3 5" text) never matches (#367).</summary>
    private static void DiffTone(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        ResultColumn[] columns = [new("id", "int", "text"), new("name", "varchar", "text")];
        var budget = store.BeginQuery("diff");
        ResultSetBuffer Side(int index, string[][] rows)
        {
            var set = store.Open(budget, index, 1, 1, "rows", columns, [WireKind.Text, WireKind.Text])!;
            foreach (var row in rows)
            {
                set.CountRow();
                var builder = set.BeginRow()!;
                foreach (var cell in row) builder.AppendText(cell);
                set.TryCommitRow();
            }
            set.Complete();
            return set;
        }
        var left = Side(0, [["1", "a"], ["2", "b"]]);
        var right = Side(1, [["1", "a"], ["2", "b"], ["3", "c"]]);
        var diff = Call<ResultsDiffResult>("results.diff", new { left = left.ResultId, right = right.ResultId });
        var added = Call<ResultsSearchResult>("results.search", new { resultId = diff.Descriptor.ResultId, text = "added", fromRow = 0, maxMatches = 100 });
        var three = Call<ResultsSearchResult>("results.search", new { resultId = diff.Descriptor.ResultId, text = "3", fromRow = 0, maxMatches = 100 });
        var tone = diff.Descriptor.Columns.ToList().FindIndex(ResultTextWriter.Hidden);
        check(tone >= 0 && diff.Added == 1 && added.Total == 0 && three.Total == 2 && three.MatchColumns.All(column => column != tone),
            "a search of a diff result skips its hidden tone column: \"added\" matches nothing and a digit only the grid's cells, R2 and id (" + added.Total + ", " + three.Total + ")");
    }
}
