using System.Text;

namespace Varia.Backend.Results;

/// <summary>How results.distinct orders a column's values: most frequent first (ties by value), or by value as the sort
/// orders them.</summary>
internal enum DistinctOrder { Count, Value }

/// <summary>What results.distinct found: the rows it looked at, the NULL count, every distinct value the search kept
/// (Distinct) and the first of them (Values) in the order asked; with a kept view, whether it has a NULL, whether it holds a
/// value past those listed, and when it holds some, the representative rows of the fewer of those past values it holds
/// (UnlistedHeld) or does not (UnlistedDropped) when they fit one filter.</summary>
internal sealed record DistinctOutcome(long Rows, long Nulls, long Distinct, bool Approximate, DistinctValue[] Values, bool? NullsKept = null, bool? UnlistedKept = null,
    int[]? UnlistedHeld = null, int[]? UnlistedDropped = null);

internal static partial class ViewSorter
{
    /// <summary>The most values one results.distinct answers (limits.distinct.maxValues), the In filter's own limit, so a
    /// checklist built from an answer always fits one filter.</summary>
    public const int MaxDistinctValues = MaxFilterValues;
    /// <summary>Characters of a value's display text returned (limits.distinct.valueChars); a longer one ends in "…".</summary>
    public const int DistinctValueChars = 256;

    /// <summary>What results.distinct holds while it runs, charged to the result's budget: the column's key (as a filter's,
    /// 16 bytes a row and a NULL bit), the rows it groups (4 bytes a row), up to one group a row (a count and a kept mark, 5
    /// bytes), a kept view's row marks (1 byte a row) and the count order's ranking (4 bytes a group), and the answer (up
    /// to 1 KiB a value listed: its text and its encoding).</summary>
    public static long DistinctWorkingBytes(long rows, int maxValues) => WorkingBytes(rows, 1) + 14L * rows + 1024L * maxValues + 4096;

    /// <summary>A column's distinct values over a view's rows (or the sealed rows), each with its count and representative
    /// base row: the lowest base row holding it, so an In or NotIn filter by those rows compares exactly these values.
    /// Values are equal as a filter compares them (<see cref="Build(ResultSetBuffer, StoredPage[], IReadOnlyList{ViewKey},
    /// IReadOnlyList{ViewFilter}, CancellationToken)"/>): the column's collation decides which texts are one value, and a
    /// truncated value compares by its stored prefix (Approximate). NULL and unreadable cells are counted apart. A search
    /// keeps the values whose display text contains it, as the results search matches a cell. With <paramref name="kept"/>,
    /// another view of the result, each value says whether a row of that view holds it (equal as above), so a checklist
    /// over one view can show what a filtered view keeps of every value it lists.</summary>
    public static DistinctOutcome DistinctValues(ResultSetBuffer set, StoredPage[] pages, ResultView? view, int column, DistinctOrder order, string? search, int maxValues, CancellationToken token, ResultView? kept = null)
    {
        long total = 0;
        foreach (var page in pages) total += page.Rows;
        if (total > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to list its values.");
        var rows = (int)total;
        var source = new PageSource(pages, set.Wires.Count);
        var approximate = false;
        var key = Build(set, source, new ViewKey(column, false, SortMode.Value), null, rows, token, ref approximate);
        var looked = view?.Order.Length ?? rows;
        var values = new int[looked];
        var count = 0;
        long nulls = 0;
        for (var i = 0; i < looked; i++)
        {
            if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            var row = view is null ? i : view.Order[i];
            if (row >= rows) continue;
            if (key.IsNull(row)) nulls++;
            else values[count++] = row;
        }
        // The kept view's rows; one outside the listed rows can only hold a value nobody listed.
        bool[]? marks = null;
        bool? nullsKept = null;
        if (kept is not null)
        {
            marks = new bool[rows];
            nullsKept = false;
            for (var i = 0; i < kept.Order.Length; i++)
            {
                if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var row = kept.Order[i];
                if (row >= rows) continue;
                marks[row] = true;
                if (key.IsNull(row)) nullsKept = true;
            }
        }
        // Ties fall back to the base row, so each run of equal values starts with the lowest row holding it.
        if (count > 1) Array.Sort(values, 0, count, new Comparer([key], null, token));
        var matcher = search is null ? null : ResultSearcher.MatcherFor(set.Columns[column], set.Wires[column], search);
        var scratch = new ResultSearcher.Scratch();
        // Groups in value order, in place: the representative rows over the front of `values` (a group's slot is never past
        // its first row), their counts and kept marks beside them.
        var counts = new int[count];
        var held = marks is null ? null : new bool[count];
        var groups = 0;
        for (int start = 0, steps = 0; start < count; steps++)
        {
            // Counted in groups looked at, not kept: a search that keeps few must still notice a cancel.
            if ((steps & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            var first = values[start];
            var end = start + 1;
            var any = marks is not null && marks[first];
            for (; end < count && key.Compare(first, values[end]) == 0; end++)
            {
                // One value can hold most rows, and comparing long texts under a collation is slow.
                if ((end & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                any |= marks is not null && marks[values[end]];
            }
            if (search is null || (matcher is not null && matcher.Matches(source.Cell(first, column), scratch)))
            {
                values[groups] = first;
                counts[groups] = end - start;
                if (held is not null) held[groups] = any;
                groups++;
            }
            start = end;
        }
        // Most frequent first: the group's place in value order breaks count ties, so equal counts stay in it.
        int[]? ranked = null;
        if (order == DistinctOrder.Count)
        {
            ranked = new int[groups];
            for (var i = 0; i < groups; i++) ranked[i] = i;
            Array.Sort(ranked, (a, b) => counts[a] != counts[b] ? counts[b].CompareTo(counts[a]) : a.CompareTo(b));
        }
        var listed = Math.Min(maxValues, groups);
        var answer = new DistinctValue[listed];
        for (var i = 0; i < listed; i++)
        {
            var g = ranked?[i] ?? i;
            answer[i] = new DistinctValue(values[g], Display(source, values[g], column, set.Wires[column]), counts[g], held is null ? null : held[g]);
        }
        // Whether the kept view holds a value past those listed and, when it holds some, which: the fewer side's rows, so a
        // checklist can leave every value it never listed as the kept view has it (keeping the held ones or dropping the
        // others) within one filter's values.
        bool? unlistedKept = null;
        int[]? unlistedHeld = null, unlistedDropped = null;
        if (held is not null)
        {
            var past = groups - listed;
            var heldPast = 0;
            for (var i = listed; i < groups; i++)
            {
                if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                if (held[ranked?[i] ?? i]) heldPast++;
            }
            unlistedKept = heldPast > 0;
            var keptSide = heldPast <= past - heldPast;
            var side = keptSide ? heldPast : past - heldPast;
            if (heldPast > 0 && side <= MaxFilterValues)
            {
                var sideRows = new int[side];
                for (int i = listed, n = 0; n < side; i++)
                {
                    var g = ranked?[i] ?? i;
                    if (held[g] == keptSide) sideRows[n++] = values[g];
                }
                if (keptSide) unlistedHeld = sideRows; else unlistedDropped = sideRows;
            }
        }
        return new DistinctOutcome(looked, nulls, groups, approximate, answer, nullsKept, unlistedKept, unlistedHeld, unlistedDropped);
    }

    /// <summary>A cell's grid text, cut to <see cref="DistinctValueChars"/> characters with "…": binary as 0x and hex, and
    /// a truncated stored value marked too.</summary>
    private static string Display(PageSource source, int row, int column, WireKind wire)
    {
        var view = source.ViewOf(row, out var local);
        var cell = view.Span(column, local);
        var cut = view.IsTruncated(column, local);
        string text;
        if (wire == WireKind.Binary)
        {
            var take = Math.Min(cell.Length, DistinctValueChars / 2 - 1);
            cut |= take < cell.Length;
            text = "0x" + Convert.ToHexString(cell[..take]);
        }
        else
        {
            var take = Math.Min(cell.Length, 4 * DistinctValueChars);
            cut |= take < cell.Length;
            text = Encoding.UTF8.GetString(cell[..take]);
            // A copy cut inside a UTF-8 sequence decodes its last character as U+FFFD.
            if (take < cell.Length && text.EndsWith('�')) text = text[..^1];
            if (text.Length > DistinctValueChars)
            {
                text = text[..(char.IsHighSurrogate(text[DistinctValueChars - 1]) ? DistinctValueChars - 1 : DistinctValueChars)];
                cut = true;
            }
        }
        return cut ? text + "…" : text;
    }
}
