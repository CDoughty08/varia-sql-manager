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
        ResultSearcher.Search(set, set.SealedSnapshot(), view, text, fromRow, backward, max, CancellationToken.None);

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
    }
}
