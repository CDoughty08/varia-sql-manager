using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Match modes (results.diff's match: position, whole rows, a composite key of chosen columns), repeated keys,
/// possible matches (look-alikes) and their bounds, tone kinds and flags under their caps, the gap and trailing counts, and
/// the host's answer and refusals.</summary>
internal static partial class DiffChecks
{
    private static readonly ResultColumn[] Wide =
        [new("Id", "int", "text"), new("A", "int", "text"), new("B", "int", "text"), new("C", "int", "text"), new("D", "int", "text")];

    private static DiffModel Diff(ResultSetBuffer left, ResultSetBuffer right, DiffMatch match, Func<long, bool>? reserve = null) =>
        ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None, reserve, match: match);

    private static DiffMatch By(params int[] pairs) => new(DiffMatchMode.Columns, pairs);

    private static string Flagged(DiffModel model) => string.Join(" ", model.Entries.Select((entry, at) => (entry.Flags & DiffFlags.Repeated) != 0 ? at.ToString(System.Globalization.CultureInfo.InvariantCulture) : null).Where(at => at is not null));

    private static void Matches(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        check(System.Runtime.CompilerServices.Unsafe.SizeOf<DiffEntry>() == 20, "an entry with its flags still takes the 20 bytes the working memory charges");

        // Position: the n-th row with the n-th, whatever the key says; no look-alikes are sought.
        var (left, right) = Pair(store, [["1", "a", "1.00"], ["2", "b", "2.00"], ["3", "c", "3.00"]], [["2", "b", "2.00"], ["1", "a", "1.00"]]);
        var position = Diff(left, right, new DiffMatch(DiffMatchMode.Position, []));
        check(position.Mode == DiffMatchMode.Position && position.KeyPairs.Length == 0 && Entries(position) == "~0:0 ~1:1 -2:" && position.Possible.Count == 0 && !position.PossibleSkipped,
            "position matching pairs the n-th rows and leaves the rest removed: " + Entries(position));
        var auto = Diff(left, right, DiffMatch.Auto);
        var rows = Diff(left, right, new DiffMatch(DiffMatchMode.Rows, []));
        check(auto.Mode == DiffMatchMode.Auto && auto.KeyPairs is [0] && rows.Mode == DiffMatchMode.Rows && rows.KeyPairs.Length == 0 && Entries(rows) == "=1:0 -2: =0:1",
            "auto keeps its key; whole rows asked directly match whole rows although a key exists: " + Entries(rows));

        // A composite key: Id repeats, (Id, Name) does not, so nothing is flagged and the rows pair by both.
        var (cl, cr) = Pair(store, [["1", "a", "1"], ["1", "b", "2"], ["2", "a", "3"]], [["1", "b", "9"], ["2", "a", "3"], ["1", "a", "1"]]);
        var composite = Diff(cl, cr, By(0, 1));
        check(composite.Mode == DiffMatchMode.Columns && composite.KeyPairs is [0, 1] && Entries(composite) == "~1:0 =2:1 =0:2" && composite.Repeated() == 0,
            "a composite key matches by its columns together: " + Entries(composite));
        // The key alone repeats: the k-th copy pairs with the k-th, and every entry of a repeated key is flagged, an added one too.
        var (rl, rr) = Pair(store, [["1", "a", "1"], ["1", "b", "2"], ["2", "c", "3"]], [["1", "a", "1"], ["1", "x", "2"], ["1", "y", "5"], ["2", "c", "3"]]);
        var repeated = Diff(rl, rr, By(0));
        check(Entries(repeated) == "=0:0 ~1:1 +:2 =2:3" && Flagged(repeated) == "0 1 2" && repeated.Repeated() == 3,
            "a repeated key pairs copies in order and flags every entry of that key: " + Entries(repeated) + " / " + Flagged(repeated));
        // NULL matches NULL; two NULL keys repeat.
        var (nl, nr) = Pair(store, [[NULL, "a", "1"], ["5", "b", "2"]], [["5", "b", "3"], [NULL, "a", "1"]]);
        var nulls = Diff(nl, nr, By(0));
        check(Entries(nulls) == "~1:0 =0:1" && nulls.Repeated() == 0, "a NULL key matches a NULL key: " + Entries(nulls));
        var (nnl, nnr) = Pair(store, [[NULL, "a", "1"], [NULL, "b", "2"]], [[NULL, "a", "1"], [NULL, "b", "2"]]);
        var twoNulls = Diff(nnl, nnr, By(0));
        check(Entries(twoNulls) == "=0:0 =1:1" && twoNulls.Repeated() == 2, "several NULL keys are a repeated key: " + Flagged(twoNulls));
        // Float and binary columns may be chosen; their values compare exactly.
        ResultColumn[] floats = [new("F", "float", "text"), new("V", "int", "text")];
        var (fl, fr) = Pair(store, [["1.5", "1"], ["2.25", "2"]], [["2.25", "3"], ["1.5", "1"]], floats, floats);
        var byFloat = Diff(fl, fr, By(0));
        check(Entries(byFloat) == "~1:0 =0:1", "a float column can be the key: " + Entries(byFloat));
        // A truncated key value is refused, rather than matched by its prefix.
        var budget = store.BeginQuery("truncated");
        var tl = Truncated(store, budget, 0);
        var tr = Fill(store, budget, 1, [["1", "a", "1"]]);
        string? truncated = null;
        try { Diff(tl, tr, By(1)); }
        catch (RequestException error) { truncated = error.Code + ": " + error.Message; }
        check(truncated == "DIFF_KEY_TRUNCATED: " + ResultDiffer.KeyTruncated, "a key column holding a truncated value is refused with DIFF_KEY_TRUNCATED: " + truncated);
        var untouched = Diff(tl, tr, By(0));
        check(untouched.Approximate, "a truncated value outside the key still only makes the diff approximate");
        string? range = null;
        try { Diff(cl, cr, By(3)); }
        catch (RequestException error) { range = error.Code; }
        check(range == "INVALID_PARAMS", "a key pair past the pairs is refused: " + range);

        LookAlikeChecks(check, store);
        FlagTones(check, store);
        HostMatch(check, store);
    }

    private static ResultSetBuffer Truncated(ResultStore store, QueryBudget budget, int index)
    {
        var set = store.Open(budget, index, 1, 1, "rows", Columns, Wires)!;
        set.CountRow();
        var builder = set.BeginRow()!;
        builder.AppendText("1");
        builder.AppendText("a", truncated: true);
        builder.AppendText("1");
        set.TryCommitRow(1);
        set.Complete();
        return set;
    }

    /// <summary>Look-alikes: 75% of the compared columns equal with min(3) not NULL, mutual unique best, ties kept apart, no
    /// compared columns, whole-row matching, and the bounds that skip the search.</summary>
    private static void LookAlikeChecks(Action<bool, string> check, ResultStore store)
    {
        // Id changed from 1 to 9 but A..D agree: removed and added look alike. Row 2 is unrelated.
        var (left, right) = Pair(store, [["1", "10", "20", "30", "40"], ["2", "1", "2", "3", "4"]], [["9", "10", "20", "30", "41"], ["2", "1", "2", "3", "4"]], Wide, Wide);
        var model = Diff(left, right, DiffMatch.Auto);
        var removed = Array.FindIndex(model.Entries, entry => entry.Kind == DiffKind.Removed);
        var added = Array.FindIndex(model.Entries, entry => entry.Kind == DiffKind.Added);
        check(model.KeyPair == 0 && model.Possible.Count == 2 && model.Possible[removed] == 0 && model.Possible[added] == 0 && model.Counts() is { Removed: 1, Added: 1 },
            "a removed and an added row agreeing in 3 of 4 compared columns are a possible match, counts unchanged");
        var (l2, r2) = Pair(store, [["1", "10", "20", "30", "40"]], [["9", "10", "20", "31", "41"]], Wide, Wide);
        check(Diff(l2, r2, DiffMatch.Auto).Possible.Count == 0, "2 of 4 equal is under 75%: no possible match");
        var (l3, r3) = Pair(store, [["1", "10", NULL, NULL, "40"]], [["9", "10", NULL, NULL, "41"]], Wide, Wide);
        check(Diff(l3, r3, DiffMatch.Auto).Possible.Count == 0, "equal NULLs count toward 75% but not toward the 3 values that must agree");
        // A tie on either side keeps neither.
        var (l4, r4) = Pair(store, [["1", "10", "20", "30", "40"]], [["8", "10", "20", "30", "41"], ["9", "10", "20", "30", "42"]], Wide, Wide);
        check(Diff(l4, r4, DiffMatch.Auto).Possible.Count == 0, "two equally good partners are a tie: no possible match");
        var (l5, r5) = Pair(store, [["1", "10", "20", "30", "40"], ["2", "10", "20", "30", "40"]], [["9", "10", "20", "30", "40"], ["3", "1", "2", "3", "4"]], Wide, Wide);
        check(Diff(l5, r5, DiffMatch.Auto).Possible.Count == 0, "an added row two removed rows match equally is a tie on its side");
        // Mutual best: the closer pair is kept over a weaker one.
        var (l6, r6) = Pair(store, [["1", "10", "20", "30", "40"]], [["8", "10", "20", "30", "41"], ["9", "10", "20", "30", "40"]], Wide, Wide);
        var best = Diff(l6, r6, DiffMatch.Auto);
        check(best.Possible.Values.Contains(1) && best.Possible.Count == 2, "the unique best partner is the possible match");
        // Every pair a key: nothing is compared, so nothing is sought (and nothing skipped).
        var allKeys = Diff(left, right, By(0, 1, 2, 3, 4));
        check(allKeys.Possible.Count == 0 && !allKeys.PossibleSkipped, "with every pair a key there is nothing to compare: no search, not skipped");
        // Whole rows: a row with one changed value is removed and added, and looks alike over all its columns.
        var (l7, r7) = Pair(store, [["1", "10", "20", "30", "40"]], [["1", "10", "20", "30", "41"]], Wide, Wide);
        var wholeRows = Diff(l7, r7, new DiffMatch(DiffMatchMode.Rows, []));
        check(wholeRows.Mode == DiffMatchMode.Rows && wholeRows.Possible.Count == 2, "whole-row matching looks for look-alikes over every pair");

        // Bounds: more than 1,000 removed rows, or more comparisons than allowed, or memory refused, skip the search.
        string?[][] Many(int count, int offset) => [.. Enumerable.Range(0, count).Select(i => new[] { (i + offset).ToString(System.Globalization.CultureInfo.InvariantCulture), "1", "2", "3", "4" })];
        var (bl, br) = Pair(store, Many(ResultDiffer.MaxLookAlikeRows + 1, 0), Many(1, 100_000), Wide, Wide);
        var tooMany = Diff(bl, br, DiffMatch.Auto);
        check(tooMany.PossibleSkipped && tooMany.Possible.Count == 0, "more than 1,000 removed rows skip the search");
        var (wl, wr) = Pair(store, Many(1000, 0), Many(1001, 100_000), Wide, Wide);
        check(Diff(wl, wr, DiffMatch.Auto).PossibleSkipped, "more than 1,000 added rows skip the search");
        var wideColumns = new[] { new ResultColumn("Id", "int", "text") }.Concat(Enumerable.Range(1, 5).Select(i => new ResultColumn("c" + i.ToString(System.Globalization.CultureInfo.InvariantCulture), "int", "text"))).ToArray();
        string?[][] ManyWide(int count, int offset) => [.. Enumerable.Range(0, count).Select(i => new[] { (i + offset).ToString(System.Globalization.CultureInfo.InvariantCulture), "1", "2", "3", "4", "5" })];
        var (xl, xr) = Pair(store, ManyWide(900, 0), ManyWide(900, 100_000), wideColumns, wideColumns);
        check(900L * 900 * 5 > ResultDiffer.MaxLookAlikeWork && Diff(xl, xr, DiffMatch.Auto).PossibleSkipped, "more than 4,000,000 comparisons skip the search");
        var refused = Diff(left, right, DiffMatch.Auto, bytes => bytes != 2L * 4 * 9);
        check(refused.PossibleSkipped && refused.Possible.Count == 0, "the values read are charged as working memory, and a refusal skips the search");
    }

    /// <summary>Tone kinds and flags as the unified result writes them, under their caps; gap counts and the trailing count.</summary>
    private static void FlagTones(Action<bool, string> check, ResultStore store)
    {
        var builder = new System.Text.StringBuilder();
        var worst = UnifiedDiff.Tone(builder, "removed", new UnifiedDiff.ToneFlags(true, int.MaxValue - 1, int.MaxValue), []);
        check(worst == "removed dup poss=2147483647 gap=2147483647" && worst.Length - "removed ".Length == 34, "the longest flags are 34 characters: " + worst);
        var scattered = Enumerable.Range(0, 2000).Where(c => c % 2 == 0).ToArray();
        var cut = UnifiedDiff.Tone(builder, "changedOld", new UnifiedDiff.ToneFlags(true, int.MaxValue - 1, int.MaxValue), scattered);
        check(cut.Length <= UnifiedDiff.MaxToneChars && cut.StartsWith("changedOld dup poss=2147483647 gap=2147483647 0 2 ", StringComparison.Ordinal) && cut.EndsWith(" …", StringComparison.Ordinal),
            "a cut tone keeps its kind and flags within 500 characters: " + cut.Length);

        // Columns matching, a removed row inside a run of unchanged rows, Changes only: the gaps count only unchanged entries.
        string?[][] Rows(params int[] skip) => [.. Enumerable.Range(1, 10).Where(i => !skip.Contains(i)).Select(i => new[] { i.ToString(System.Globalization.CultureInfo.InvariantCulture), "n", i == 9 && skip.Length > 0 ? "0" : "1" })];
        var (left, right) = Pair(store, Rows(), Rows(4));
        var model = Diff(left, right, By(0));
        var unified = store.Open(left.Budget, 5, 1, 1, "diff", UnifiedDiff.Columns(right, model), UnifiedDiff.Wires(right, model), lengths: UnifiedDiff.Lengths(right, model))!;
        var trailing = UnifiedDiff.Write(unified, left, left.SealedSnapshot(), right, right.SealedSnapshot(), model, 0, CancellationToken.None);
        var tones = Text(unified).Select(row => row.Split('|')[^1]).ToArray();
        check(tones is ["removed gap=3", "changedOld gap=4 2", "changedNew 2"] && trailing == 1,
            "gaps count the unchanged entries before each stored row, a change's on its old half, and the trailing run is counted apart: " + string.Join(" / ", tones) + " +" + trailing);
        var all = store.Open(left.Budget, 6, 1, 1, "diff", UnifiedDiff.Columns(right, model), UnifiedDiff.Wires(right, model), lengths: UnifiedDiff.Lengths(right, model))!;
        check(UnifiedDiff.Write(all, left, left.SealedSnapshot(), right, right.SealedSnapshot(), model, -1, CancellationToken.None) == 0 && Text(all).All(row => !row.Contains("gap=", StringComparison.Ordinal)),
            "All rows leaves nothing out: no gap flags and nothing trailing");

        // A repeated key and a possible match in the stored tones.
        var (rl, rr) = Pair(store, [["1", "a", "1"], ["1", "b", "2"], ["7", "plum", "3"]], [["1", "a", "1"], ["1", "b", "5"], ["8", "plum", "3"]]);
        var flagged = Diff(rl, rr, By(0));
        var written = store.Open(rl.Budget, 7, 1, 1, "diff", UnifiedDiff.Columns(rr, flagged), UnifiedDiff.Wires(rr, flagged), lengths: UnifiedDiff.Lengths(rr, flagged))!;
        UnifiedDiff.Write(written, rl, rl.SealedSnapshot(), rr, rr.SealedSnapshot(), flagged, -1, CancellationToken.None);
        var stored = Text(written).Select(row => row.Split('|')[^1]).ToArray();
        check(stored is ["same dup", "changedOld dup 2", "changedNew dup 2", "removed poss=3", "added poss=3"] && flagged.Possible.Count == 2,
            "a repeated key's rows are flagged dup on both halves, and a look-alike pair names its partner: " + string.Join(" / ", stored));
        var (pl, pr) = Pair(store, [["1", "x", "1"], ["2", "plum", "3"]], [["1", "x", "1"], ["9", "plum", "3"]]);
        // Two compared columns: both must agree (75%), and min(3, 2) = 2 of them hold values.
        var possible = Diff(pl, pr, By(0));
        var poss = store.Open(pl.Budget, 8, 1, 1, "diff", UnifiedDiff.Columns(pr, possible), UnifiedDiff.Wires(pr, possible), lengths: UnifiedDiff.Lengths(pr, possible))!;
        UnifiedDiff.Write(poss, pl, pl.SealedSnapshot(), pr, pr.SealedSnapshot(), possible, -1, CancellationToken.None);
        var possTones = Text(poss).Select(row => row.Split('|')[^1]).ToArray();
        check(possTones is ["NULL", "removed poss=2", "added poss=2"], "a possible match's rows name their partner's row in the other input: " + string.Join(" / ", possTones));
    }

    /// <summary>results.diff's match parameter and answer through the host.</summary>
    private static void HostMatch(Action<bool, string> check, ResultStore store)
    {
        using var service = new SqlService(store);
        T Call<T>(object args) => (T)service.DispatchAsync("results.diff", JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        string? Code(object args)
        {
            try { Call<object>(args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var (left, right) = Pair(store, [["1", "a", "1.00"], ["2", "b", "2.00"]], [["1", "A", "1.50"], ["3", "b", "2.00"]]);
        var byColumns = Call<ResultsDiffResult>(new { left = left.ResultId, right = right.ResultId, context = -1, match = new { mode = "columns", columns = new[] { 0, 1 } } });
        check(byColumns.Match is { Mode: "columns", Columns: ["ItemId", "Name"] } && byColumns is { Changed: 1, Added: 1, Removed: 1, Possible: 1, Repeated: 0, PossibleSkipped: false, NothingPaired: false, TrailingHidden: 0 }
            && byColumns.ColumnChanges.Length == 3 && byColumns.ColumnChanges[2] is { Changed: 1, Soft: 0 } && byColumns.ColumnChanges[1] is { Changed: 0, Soft: 1 },
            "results.diff matches by the columns asked and answers what matched, per-column changes and the flags' counts");
        var byPosition = Call<ResultsDiffResult>(new { left = left.ResultId, right = right.ResultId, match = new { mode = "position" } });
        var byRows = Call<ResultsDiffResult>(new { left = left.ResultId, right = right.ResultId, match = new { mode = "rows" } });
        check(byPosition.Match is { Mode: "position", Columns: [] } && byPosition.Changed == 2 && byRows.Match is { Mode: "rows", Columns: [] } && byRows is { NothingPaired: true, Possible: 0 },
            "position and whole rows answer their mode, and nothing paired is said");
        var (tl, tr) = Pair(store, [["1", "x", "1"]], [["1", "y", "2"]]);
        var trailing = Call<ResultsDiffResult>(new { left = tl.ResultId, right = tr.ResultId, context = 0, match = new { mode = "position" } });
        check(trailing is { TrailingHidden: 0, Changed: 1 }, "a change with nothing after it trails nothing");
        var budget = store.BeginQuery("truncated host");
        var cut = Truncated(store, budget, 0);
        var whole = Fill(store, budget, 1, [["1", "a", "1"]]);
        var codes = new[]
        {
            Code(new { left = cut.ResultId, right = whole.ResultId, match = new { mode = "columns", columns = new[] { 1 } } }),
            Code(new { left = left.ResultId, right = right.ResultId, match = new { mode = "columns", columns = new[] { 3 } } }),
            Code(new { left = left.ResultId, right = right.ResultId, match = new { mode = "columns", columns = Enumerable.Range(0, 17).ToArray() } }),
            Code(new { left = left.ResultId, right = right.ResultId, match = new { mode = "columns", columns = new[] { 0, 0 } } }),
            Code(new { left = left.ResultId, right = right.ResultId, match = new { mode = "columns", columns = Array.Empty<int>() } }),
            Code(new { left = left.ResultId, right = right.ResultId, match = new { mode = "rows", columns = new[] { 0 } } }),
            Code(new { left = left.ResultId, right = right.ResultId, match = new { mode = "key" } })
        };
        check(string.Join(",", codes) == "DIFF_KEY_TRUNCATED,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS",
            "results.diff refuses a truncated key with its own code and a malformed match with INVALID_PARAMS: " + string.Join(",", codes));
    }
}
