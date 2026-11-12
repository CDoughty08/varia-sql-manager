using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Row identities for highlights (results.identify, results.rowIds, results.findRows): the key column Auto picks,
/// the whole-row fallback, collation-aware hashing that matches the same rows across results and sorted views, and the
/// registry's budget and limits.</summary>
internal static class IdentityChecks
{
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation Bin2 = new(1033, 0, 1252, false, 16384);

    private static readonly ResultColumn[] Columns =
    [
        new("Name", "nvarchar", "text", Collation: CaseInsensitive), new("Sku", "varchar", "text", Collation: Bin2), new("ItemId", "int", "text"),
        new("Price", "decimal", "text", Precision: 10, Scale: 2), new("Tone", "nvarchar", "text", Role: "tone")
    ];
    private static readonly WireKind[] Wires = [WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Text];
    private static int sessions;

    public static void Run(Action<bool, string> check)
    {
        Hashing(check);
        Threads(check);
        Picking(check);
        Memory(check);
        Host(check);
    }

    private static ResultSetBuffer Fill(ResultStore store, string?[][] rows, ResultColumn[]? columns = null, WireKind[]? wires = null)
    {
        var set = store.Open(store.BeginQuery("identity" + Interlocked.Increment(ref sessions)), 0, 1, 1, "rows", columns ?? Columns, wires ?? Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var row in rows)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            foreach (var cell in row)
            {
                if (cell is null) builder.AppendNull();
                else builder.AppendText(cell);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    /// <summary>Rows hashed on several threads have the identities one thread gives them, a repeat or a NULL is found
    /// wherever it is, and two results compare the same.</summary>
    private static void Threads(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        const int count = 130_000;
        var invariant = System.Globalization.CultureInfo.InvariantCulture;
        // id: each its own. twin: each its own but for two rows far apart, past the rows a key is first tried on. gap: one NULL, late.
        ResultColumn[] columns = [new("id", "int", "text"), new("twin", "int", "text"), new("gap", "int", "text"), new("name", "nvarchar", "text", Collation: CaseInsensitive), new("at", "datetimeoffset", "text")];
        string?[][] Rows(int changed) => [.. Enumerable.Range(0, count).Select(i => new[]
        {
            i.ToString(invariant), (i == 120_000 ? 40_000 : i).ToString(invariant), i == 99_999 ? null : i.ToString(invariant),
            (i % 2 == 0 ? "Name " : "NAME ") + ((uint)i * 2654435761u % 9000) + (i == changed ? "!" : ""), "2024-01-01 00:00:00.0000000 +0" + i % 10 + ":00"
        })];
        var set = Fill(store, Rows(-1), columns);
        var other = Fill(store, Rows(77_777), columns);
        var pages = set.SealedSnapshot();
        (int Column, bool Unique, bool Approximate, long[] Ids) Built(IdentityBy by, int column = -1) => RowIdentity.Build(set, pages, by, column, CancellationToken.None);
        var byRow = Built(IdentityBy.Row);
        var byId = Built(IdentityBy.Column, 0);
        var byTwin = Built(IdentityBy.Column, 1);
        var byGap = Built(IdentityBy.Column, 2);
        var auto = Built(IdentityBy.Auto);
        var diff = ResultDiffer.Compare(set, pages, other, other.SealedSnapshot(), false, CancellationToken.None);
        (int Column, bool Unique, bool Approximate, long[] Ids) rowAlone, twinAlone;
        DiffModel diffAlone;
        var workers = ViewSorter.Workers;
        try
        {
            ViewSorter.Workers = 1;
            rowAlone = Built(IdentityBy.Row);
            twinAlone = Built(IdentityBy.Column, 1);
            diffAlone = ResultDiffer.Compare(set, pages, other, other.SealedSnapshot(), false, CancellationToken.None);
        }
        finally { ViewSorter.Workers = workers; }
        check(pages.Length > 8 && byRow.Ids.AsSpan().SequenceEqual(rowAlone.Ids) && byRow.Unique && rowAlone.Unique && byTwin.Ids.AsSpan().SequenceEqual(twinAlone.Ids)
            && byId.Unique && !byTwin.Unique && !twinAlone.Unique && !byGap.Unique && auto is { Column: 0, Unique: true },
            "rows hashed on several threads have one thread's identities; a repeat or a NULL past the first rows tried still makes a column no key, and Auto takes the first that is one");
        check(diff.Entries.AsSpan().SequenceEqual(diffAlone.Entries) && diff.Cells.AsSpan().SequenceEqual(diffAlone.Cells) && diff.KeyPair == diffAlone.KeyPair
            && diff.Entries.Count(entry => entry.Kind != DiffKind.Same) == 1,
            "two results compare the same on several threads as on one: the one changed row, by the same key (" + diff.Entries.Count(entry => entry.Kind != DiffKind.Same) + " rows differ)");
        long[] spread = new long[6];
        check(RowIdentity.Distinct([5, 1, 9, 1L << 52, 3, 7], spread, CancellationToken.None) && !RowIdentity.Distinct([5, 1, 9, 5, 3, 7], spread, CancellationToken.None)
            && RowIdentity.Distinct([], [], CancellationToken.None) && RowIdentity.Distinct([4], new long[1], CancellationToken.None)
            && RowIdentity.WorkingBytes(1000) == 8000 + 24_000 && RowIdentity.WorkingBytes(1_000_000) == 8_000_000 + 24L * RowIdentity.Probe,
            "identities are told apart by sorting them in parts: any two equal ones are found; the check holds 8 bytes a row and a set of the first rows");
    }

    private static long[] Ids(ResultSetBuffer set, IdentityBy by, int column = -1) => RowIdentity.Build(set, set.SealedSnapshot(), by, column, CancellationToken.None).Ids;

    /// <summary>Auto trying every candidate and falling back to whole rows allocates no more than results.identify reserves
    /// (WorkingBytes plus the ids it keeps): one ids array and one set serve every pass.</summary>
    private static void Memory(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        const int rows = 40_000;
        // Every candidate column repeats a value at its last row, so each is filled to the end before it fails.
        var columns = Enumerable.Range(0, RowIdentity.MaxCandidates + 1).Select(c => new ResultColumn("Key" + c.ToString(System.Globalization.CultureInfo.InvariantCulture) + "Id", "int", "text")).ToArray();
        var data = Enumerable.Range(0, rows).Select(r => columns.Select(_ => (string?)(r == rows - 1 ? "0" : r.ToString(System.Globalization.CultureInfo.InvariantCulture))).ToArray()).ToArray();
        var set = Fill(store, data, columns, [.. columns.Select(_ => WireKind.Text)]);
        var pages = set.SealedSnapshot();
        RowIdentity.Build(set, pages, IdentityBy.Auto, -1, CancellationToken.None);
        var before = GC.GetAllocatedBytesForCurrentThread();
        var built = RowIdentity.Build(set, pages, IdentityBy.Auto, -1, CancellationToken.None);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        var reserved = RowIdentity.WorkingBytes(rows) + 8L * rows;
        check(built.Column == -1 && allocated <= reserved, "Auto's candidates and whole-row fallback allocate within what results.identify reserves (" + allocated + " of " + reserved + " bytes)");
    }

    /// <summary>Values SQL Server compares equal hash alike; others apart.</summary>
    private static void Hashing(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store,
        [
            ["apple", "A-1", "1", "1.50", null],
            ["APPLE  ", "A-1  ", "01", "1.5", "error"],
            ["Apple", "a-1", "-0", "0.00", null],
            ["pear", null, "0", "-0", null]
        ]);
        var names = Ids(set, IdentityBy.Column, 0);
        var skus = Ids(set, IdentityBy.Column, 1);
        var numbers = Ids(set, IdentityBy.Column, 2);
        var prices = Ids(set, IdentityBy.Column, 3);
        check(names[0] == names[1] && names[1] == names[2] && names[0] != names[3], "a case-insensitive column hashes case and trailing spaces alike");
        check(skus[0] == skus[1] && skus[0] != skus[2] && skus[3] != skus[0], "a _BIN2 column ignores only trailing spaces; NULL hashes apart from any value");
        check(numbers[0] == numbers[1] && numbers[2] == numbers[3] && prices[0] == prices[1] && prices[2] == prices[3],
            "exact numerics hash by value: leading and trailing zeros and the sign of zero don't matter");
        check(names.Concat(skus).All(id => id is >= 0 and <= RowIdentity.Mask), "identities fit in 53 bits");
        var rows = Ids(set, IdentityBy.Row);
        check(rows[0] == rows[1] && rows[0] != rows[2], "a whole-row identity compares each value by its collation and skips the hidden tone column");
        var again = Fill(store, [["pear", null, "0", "-0", null], ["apple", "A-1", "1", "1.50", null]]);
        var later = Ids(again, IdentityBy.Row);
        check(later[0] == rows[3] && later[1] == rows[0], "the same row hashes the same in another result, so highlights follow a re-run");
        var nulls = Fill(store, [[null, "x", "1", "1", null]], [Columns[0], Columns[1], Columns[2], Columns[3], Columns[4]]);
        var shifted = Fill(store, [["x", null, "1", "1", null]]);
        check(Ids(nulls, IdentityBy.Row)[0] != Ids(shifted, IdentityBy.Row)[0], "a NULL in another column is another row");
    }

    /// <summary>Auto picks the likeliest unique key, else the whole row.</summary>
    private static void Picking(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var keyed = Fill(store, [["a", "S1", "10", "1", null], ["b", "S1", "11", "2", null], ["c", "S2", "12", "2", null]]);
        var auto = RowIdentity.Build(keyed, keyed.SealedSnapshot(), IdentityBy.Auto, -1, CancellationToken.None);
        check(auto.Column == 2 && auto.Unique, "Auto picks a unique column named like a key (ItemId) over an earlier unique one (Name)");
        var noKey = Fill(store, [["a", "S1", "10", "1", null], ["a", "S1", "10", "1", null], ["b", "S2", "10", "2", null]]);
        var fallback = RowIdentity.Build(noKey, noKey.SealedSnapshot(), IdentityBy.Auto, -1, CancellationToken.None);
        check(fallback.Column == -1 && !fallback.Unique, "with no unique key Auto falls back to the whole row, and says two rows are alike");
        var withNull = Fill(store, [["a", "S1", null, "1", null], ["b", "S2", "11", "1", null]]);
        var skipped = RowIdentity.Build(withNull, withNull.SealedSnapshot(), IdentityBy.Auto, -1, CancellationToken.None);
        check(skipped.Column == 0, "a key column may hold no NULL: Auto moves on to the next unique column");
        var candidates = RowIdentity.Candidates([new("blob", "varbinary", "binary"), new("score", "float", "text"), new("doc", "xml", "text", Role: "xml"), new("code", "nvarchar", "text", MaxLength: 40), new("RowGuid", "uniqueidentifier", "text")],
            [WireKind.Binary, WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Text]).ToArray();
        check(string.Join(",", candidates) == "4,3", "Auto never tries binary, float or xml columns, and tries key-named ones first: " + string.Join(",", candidates));
    }

    private static void Host(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Fill(store, [["c", "S1", "30", "3", null], ["a", "S2", "10", "1", null], ["b", "S3", "20", "2", null], ["a", "S4", "40", "1", null]]);
        var baseline = store.UsedBytes;
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        string? Code(string method, object args)
        {
            try { Call<object>(method, args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        check(Code("results.rowIds", new { resultId = set.ResultId, firstRow = 0, count = 4 }) == "IDENTITY_NOT_FOUND", "rows have no identities until results.identify");
        var identified = Call<ResultsIdentifyResult>("results.identify", new { resultId = set.ResultId, by = "auto" });
        var held = store.UsedBytes - baseline;
        check(new[] { "results.identify", "results.rowIds", "results.findRows" }.All(SqlService.MethodNames.Contains) && identified.Column == 2 && identified.Unique && identified.Rows == 4
            && held == 8 * 4 + ResultStore.ViewOverhead, "results.identify keeps one identity per row, charged to the result's budget (" + held + " bytes)");
        var ids = Call<ResultsRowIdsResult>("results.rowIds", new { resultId = set.ResultId, firstRow = 1, count = 10 });
        check(ids.FirstRow == 1 && ids.Ids.Length == 3 && ids.Rows == 4, "results.rowIds stops at the last row");
        var view = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 2, descending = false, mode = "value" } } });
        var viewIds = Call<ResultsRowIdsResult>("results.rowIds", new { resultId = set.ResultId, firstRow = 0, count = 4, viewId = view.ViewId });
        check(viewIds.Ids[0] == ids.Ids[0] && viewIds.Ids[1] == ids.Ids[1], "results.rowIds through a view reads its positions (ItemId 10, then 20)");
        var found = Call<ResultsFindRowsResult>("results.findRows", new { resultId = set.ResultId, ids = new[] { ids.Ids[1], 12345L } });
        var foundView = Call<ResultsFindRowsResult>("results.findRows", new { resultId = set.ResultId, ids = new[] { ids.Ids[1], 12345L }, viewId = view.ViewId });
        check(string.Join(",", found.Positions) == "2" && string.Join(",", found.Marks) == "0" && !found.Truncated && string.Join(",", foundView.Positions) == "1",
            "results.findRows finds an identity's row in the result's order and in a view's");
        var byName = Call<ResultsIdentifyResult>("results.identify", new { resultId = set.ResultId, by = "column", column = 0 });
        var nameIds = Call<ResultsRowIdsResult>("results.rowIds", new { resultId = set.ResultId, firstRow = 0, count = 4 });
        var both = Call<ResultsFindRowsResult>("results.findRows", new { resultId = set.ResultId, ids = new[] { nameIds.Ids[1] } });
        check(!byName.Unique && byName.Column == 0 && string.Join(",", both.Positions) == "1,3" && store.UsedBytes - baseline - (4 * 4 + ResultStore.ViewOverhead) == held,
            "a column chosen by hand need not be unique: one identity finds every row with its value, and the new identities replace the old");
        var codes = new[]
        {
            Code("results.identify", new { resultId = set.ResultId, by = "key" }),
            Code("results.identify", new { resultId = set.ResultId, by = "column" }),
            Code("results.identify", new { resultId = set.ResultId, by = "row", column = 1 }),
            Code("results.identify", new { resultId = set.ResultId, by = "column", column = 9 }),
            Code("results.identify", new { resultId = 999, by = "auto" }),
            Code("results.rowIds", new { resultId = set.ResultId, firstRow = 0, count = 0 }),
            Code("results.rowIds", new { resultId = set.ResultId, firstRow = 0, count = 1, viewId = 999 }),
            Code("results.findRows", new { resultId = set.ResultId, ids = Array.Empty<long>() }),
            Code("results.findRows", new { resultId = set.ResultId, ids = new[] { -1L } }),
            Code("results.findRows", new { resultId = set.ResultId, ids = new long[SqlService.MaxFindIds + 1] })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,RESULT_NOT_FOUND,INVALID_PARAMS,VIEW_NOT_FOUND,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS",
            "results.identify, rowIds and findRows check their arguments: " + string.Join(",", codes));
        var open = store.Open(store.BeginQuery("open"), 0, 1, 1, "rows", Columns, Wires)!;
        check(Code("results.identify", new { resultId = open.ResultId, by = "auto" }) == "RESULT_OPEN", "a result still loading is identified once it finishes");
        store.Release(set.ResultId);
        store.Release(open.ResultId);
        check(store.IdentityCount == 0 && store.UsedBytes == 0, "releasing a result returns its identities' memory");
        var tight = new ResultStore(4096, 4096);
        using var small = new SqlService(tight);
        var cramped = tight.Open(tight.BeginQuery("tight"), 0, 1, 1, "rows", [new("id", "int", "text")], [WireKind.Text])!;
        for (var row = 0; row < 10_000; row++)
        {
            if (cramped.BeginRow() is not { } builder) break;
            builder.AppendText(row.ToString(System.Globalization.CultureInfo.InvariantCulture));
            cramped.TryCommitRow();
        }
        cramped.Complete();
        var before = tight.UsedBytes;
        string? refused;
        try { small.DispatchAsync("results.identify", JsonSerializer.SerializeToElement(new { resultId = cramped.ResultId, by = "auto" }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); refused = null; }
        catch (RequestException error) { refused = error.Code; }
        check(refused == "TOO_LARGE" && tight.UsedBytes == before, "identities the budget has no room for answer TOO_LARGE and take nothing");
    }
}
