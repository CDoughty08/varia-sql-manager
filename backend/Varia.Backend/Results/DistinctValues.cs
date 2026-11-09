using System.Text;

namespace Varia.Backend.Results;

/// <summary>How results.distinct orders a column's values: most frequent first (ties by value), or by value as the sort
/// orders them.</summary>
internal enum DistinctOrder { Count, Value }

/// <summary>What results.distinct found: the rows it looked at, the NULL count, every distinct value the search kept
/// (Distinct) and the first of them (Values) in the order asked.</summary>
internal sealed record DistinctOutcome(long Rows, long Nulls, long Distinct, bool Approximate, DistinctValue[] Values);

internal static partial class ViewSorter
{
    /// <summary>The most values one results.distinct answers (limits.distinct.maxValues), the In filter's own limit, so a
    /// checklist built from an answer always fits one filter.</summary>
    public const int MaxDistinctValues = MaxFilterValues;
    /// <summary>Characters of a value's display text returned (limits.distinct.valueChars); a longer one ends in "…".</summary>
    public const int DistinctValueChars = 256;

    /// <summary>What results.distinct holds while it runs, charged to the result's budget: the column's key (as a filter's,
    /// 16 bytes a row and a NULL bit), the rows it groups (4 bytes a row) and up to one group a row (12 bytes).</summary>
    public static long DistinctWorkingBytes(long rows) => WorkingBytes(rows, 1) + 16L * rows + 4096;

    /// <summary>A column's distinct values over a view's rows (or the sealed rows), each with its count and representative
    /// base row: the lowest base row holding it, so an In or NotIn filter by those rows compares exactly these values.
    /// Values are equal as a filter compares them (<see cref="Build(ResultSetBuffer, StoredPage[], IReadOnlyList{ViewKey},
    /// IReadOnlyList{ViewFilter}, CancellationToken)"/>): the column's collation decides which texts are one value, and a
    /// truncated value compares by its stored prefix (Approximate). NULL and unreadable cells are counted apart. A search
    /// keeps the values whose display text contains it, as the results search matches a cell.</summary>
    public static DistinctOutcome DistinctValues(ResultSetBuffer set, StoredPage[] pages, ResultView? view, int column, DistinctOrder order, string? search, int maxValues, CancellationToken token)
    {
        long total = 0;
        foreach (var page in pages) total += page.Rows;
        if (total > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to list its values.");
        var rows = (int)total;
        var source = new PageSource(pages, set.Wires.Count);
        var approximate = false;
        var key = Build(set, source, new ViewKey(column, false, SortMode.Value), rows, token, ref approximate);
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
        // Ties fall back to the base row, so each run of equal values starts with the lowest row holding it.
        if (count > 1) Array.Sort(values, 0, count, new Comparer([key], token));
        var matcher = search is null ? null : ResultSearcher.MatcherFor(set.Columns[column], set.Wires[column], search);
        var scratch = new ResultSearcher.Scratch();
        var groups = new List<(int Row, long Count)>();
        for (var start = 0; start < count;)
        {
            if ((groups.Count & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            var end = start + 1;
            while (end < count && key.Compare(values[start], values[end]) == 0) end++;
            if (search is null || (matcher is not null && matcher.Matches(source.Cell(values[start], column), scratch)))
                groups.Add((values[start], end - start));
            start = end;
        }
        if (order == DistinctOrder.Count)
        {
            // Groups are in value order: the index breaks count ties so equal counts stay in it.
            var indexed = new (int Row, long Count, int Index)[groups.Count];
            for (var i = 0; i < indexed.Length; i++) indexed[i] = (groups[i].Row, groups[i].Count, i);
            Array.Sort(indexed, (a, b) => a.Count != b.Count ? b.Count.CompareTo(a.Count) : a.Index.CompareTo(b.Index));
            for (var i = 0; i < indexed.Length; i++) groups[i] = (indexed[i].Row, indexed[i].Count);
        }
        var kept = Math.Min(maxValues, groups.Count);
        var answer = new DistinctValue[kept];
        for (var i = 0; i < kept; i++)
        {
            var (row, many) = groups[i];
            answer[i] = new DistinctValue(row, Display(source, row, column, set.Wires[column]), many);
        }
        return new DistinctOutcome(looked, nulls, groups.Count, approximate, answer);
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
