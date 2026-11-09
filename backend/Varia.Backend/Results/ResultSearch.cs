using System.Globalization;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>What one results.search found: the rows it searched, every match among them (Total), and a run of matches in
/// row order (Rows[k], Columns[k]) with First, the number of matches before the run's first.</summary>
internal sealed record SearchOutcome(long Searched, long Total, long First, long[] Rows, int[] Columns, bool Approximate);

/// <summary>
/// Finds the cells of a stored result whose grid text contains a search text, over its sealed pages, in base order or
/// through a view (positions then count view rows). NULL and unreadable cells never match. Character columns compare by
/// their collation, as LIKE '%text%' would: its locale and its Ignore flags (case, accents, kana, width), code-point order
/// for _BIN and _BIN2, and a locale this runtime does not know by its case flag alone. Every other column compares its
/// display text ignoring case (numbers, dates, xml, json, uniqueidentifier); binary values match on their 0x… hex. A
/// truncated cell is searched by its stored prefix, which makes the outcome Approximate.
/// One pass counts every match and keeps up to MaxMatches of them, in whole rows: forward from FromRow, or backward, the
/// last ones before FromRow; a run passes MaxMatches by at most the columns of its last row.
/// The scan stops at checkpoints spaced by work done (cells and bytes compared, so a wide or long-valued result is checked
/// as often as a narrow one): on Stop, and with no outcome once the result is released or the view closed, so a search
/// never reads pages whose budget has been returned for longer than one checkpoint. What it holds besides the run is one
/// row's matches and parsed page layouts bounded by LayoutCacheBytes (one in base order, whose rows are in page order).
/// </summary>
internal static class ResultSearcher
{
    /// <summary>The most matches one search returns before finishing its last row (limits.search.maxMatches).</summary>
    public const int MaxMatches = 10_000;
    /// <summary>The longest search text, in UTF-16 code units (limits.search.maxText).</summary>
    public const int MaxText = 1024;
    /// <summary>Work between checkpoints: each cell compared counts CellWork plus its bytes.</summary>
    internal const int CheckEvery = 1 << 16;
    private const int CellWork = 16;
    /// <summary>The most parsed page layouts (44 bytes per column each) a search through a view keeps at once.</summary>
    internal const int LayoutCacheBytes = 1 << 20;

    /// <summary>Whether a search must stop without an outcome: its result was released or its view closed.</summary>
    public static Func<bool> Stopped(ResultStore store, ResultSetBuffer set, ResultView? view) =>
        () => set.IsReleased || (view is not null && !store.HasView(view));

    /// <returns>The outcome, or null when <paramref name="stopped"/> said so at a checkpoint (or the view names a row past
    /// <paramref name="pages"/>, which only a release that emptied them can cause).</returns>
    public static SearchOutcome? Search(ResultSetBuffer set, StoredPage[] pages, ResultView? view, string text, long fromRow, bool backward, int maxMatches, CancellationToken token, Func<bool>? stopped = null)
    {
        var columns = set.Wires.Count;
        var matchers = new Matcher?[columns];
        for (var c = 0; c < columns; c++) matchers[c] = MatcherFor(set.Columns[c], set.Wires[c], text);
        var source = new Source(pages, columns, view is null ? 1 : LayoutCacheBytes / (4 * PageView.ScratchLength(Math.Max(1, columns))));
        long rows = view?.Rows ?? source.Rows;
        var found = new List<int>(16);
        var keptRows = new List<long>();
        var keptColumns = new List<int>();
        // Backward keeps whole rows from `start`: rowStarts[head..] are where each kept row's matches begin.
        var rowStarts = new List<int>();
        int head = 0, start = 0;
        long total = 0, first = -1, before = 0;
        var approximate = false;
        var scratch = new Scratch();
        long work = 0;
        for (long position = 0; position < rows; position++)
        {
            if (work <= 0)
            {
                token.ThrowIfCancellationRequested();
                if (stopped?.Invoke() == true) return null;
                work = CheckEvery;
            }
            var row = view is null ? position : view.Order[position];
            if (row >= source.Rows) return null;
            var page = source.ViewOf(row, out var local);
            found.Clear();
            work -= CellWork;
            for (var c = 0; c < columns; c++)
            {
                if (matchers[c] is not { } matcher || page.IsNull(c, local)) continue;
                var truncated = page.IsTruncated(c, local);
                var cell = page.Span(c, local);
                work -= CellWork + cell.Length;
                if (matcher.Matches(cell, scratch)) found.Add(c);
                else if (truncated) approximate = true;
            }
            if (found.Count == 0) continue;
            if (!backward)
            {
                if (position >= fromRow && keptRows.Count < maxMatches)
                {
                    if (first < 0) first = total;
                    foreach (var c in found) { keptRows.Add(position); keptColumns.Add(c); }
                }
            }
            else if (position < fromRow)
            {
                before += found.Count;
                rowStarts.Add(keptRows.Count);
                foreach (var c in found) { keptRows.Add(position); keptColumns.Add(c); }
                // Drop the oldest row while the rows after it still hold maxMatches.
                while (rowStarts.Count - head > 1 && keptRows.Count - rowStarts[head + 1] >= maxMatches) head++;
                start = rowStarts[head];
                if (start > 4096 && start > keptRows.Count / 2) Compact(keptRows, keptColumns, rowStarts, ref head, ref start);
            }
            total += found.Count;
        }
        if (!backward) return new SearchOutcome(rows, total, first < 0 ? total : first, [.. keptRows], [.. keptColumns], approximate);
        var kept = keptRows.Count - start;
        return new SearchOutcome(rows, total, before - kept, keptRows.GetRange(start, kept).ToArray(), keptColumns.GetRange(start, kept).ToArray(), approximate);
    }

    private static void Compact(List<long> rows, List<int> columns, List<int> rowStarts, ref int head, ref int start)
    {
        rows.RemoveRange(0, start);
        columns.RemoveRange(0, start);
        rowStarts.RemoveRange(0, head);
        for (var i = 0; i < rowStarts.Count; i++) rowStarts[i] -= start;
        head = 0;
        start = 0;
    }

    /// <summary>How a column compares, or null when no cell of it can contain the text (a binary column and text that is not
    /// hex).</summary>
    internal static Matcher? MatcherFor(ResultColumn column, WireKind wire, string text)
    {
        if (wire == WireKind.Binary)
        {
            foreach (var c in text) if (!char.IsAsciiHexDigit(c) && c is not ('x' or 'X')) return null;
            return new HexMatcher(text);
        }
        if (column.Collation is { } collation)
        {
            // SqlCompareOptions: IgnoreCase 1, BinarySort2 16384, BinarySort 32768.
            if ((collation.Options & (16384 | 32768)) != 0) return new OrdinalMatcher(text, StringComparison.Ordinal);
            // Text of only ignorable characters (U+200B, U+00AD) is found at 0 in every string by a culture compare: it is
            // looked for as it is written instead.
            if (ViewSorter.Culture(collation) is { } culture && culture.Info.Compare(text, string.Empty, culture.Options) != 0)
                return new CultureMatcher(text, culture.Info, culture.Options);
            return new OrdinalMatcher(text, (collation.Options & 1) != 0 ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
        }
        return new OrdinalMatcher(text, StringComparison.OrdinalIgnoreCase);
    }

    internal sealed class Scratch
    {
        public char[] Chars = new char[256];

        public ReadOnlySpan<char> Decode(ReadOnlySpan<byte> utf8)
        {
            if (Chars.Length < utf8.Length) Chars = new char[Math.Max(utf8.Length, 2 * Chars.Length)];
            return Chars.AsSpan(0, Encoding.UTF8.GetChars(utf8, Chars));
        }

        public ReadOnlySpan<char> Hex(ReadOnlySpan<byte> bytes)
        {
            var length = 2 + 2 * bytes.Length;
            if (Chars.Length < length) Chars = new char[Math.Max(length, 2 * Chars.Length)];
            Chars[0] = '0';
            Chars[1] = 'x';
            for (var i = 0; i < bytes.Length; i++)
            {
                Chars[2 + 2 * i] = "0123456789ABCDEF"[bytes[i] >> 4];
                Chars[3 + 2 * i] = "0123456789ABCDEF"[bytes[i] & 15];
            }
            return Chars.AsSpan(0, length);
        }
    }

    internal abstract class Matcher
    {
        public abstract bool Matches(ReadOnlySpan<byte> cell, Scratch scratch);
    }

    private sealed class OrdinalMatcher(string text, StringComparison comparison) : Matcher
    {
        public override bool Matches(ReadOnlySpan<byte> cell, Scratch scratch) => scratch.Decode(cell).Contains(text, comparison);
    }

    private sealed class CultureMatcher(string text, CompareInfo info, CompareOptions options) : Matcher
    {
        public override bool Matches(ReadOnlySpan<byte> cell, Scratch scratch) => info.IndexOf(scratch.Decode(cell), text, options) >= 0;
    }

    private sealed class HexMatcher(string text) : Matcher
    {
        public override bool Matches(ReadOnlySpan<byte> cell, Scratch scratch) => scratch.Hex(cell).Contains(text, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The sealed pages a search reads, a row's page found by binary search and parsed when reached, its layout kept
    /// in one of a few slots (direct-mapped by page index) so a wide result's layouts never outgrow the cache.</summary>
    internal sealed class Source
    {
        private readonly StoredPage[] pages;
        private readonly long[] starts;
        private readonly int[] slotPages;
        private readonly int[]?[] slotLayouts;
        private readonly int[] slotBlobStarts;
        private readonly int columns;

        public Source(StoredPage[] pages, int columns, int slots)
        {
            this.pages = pages;
            this.columns = columns;
            starts = new long[pages.Length];
            for (var i = 0; i < pages.Length; i++)
            {
                starts[i] = pages[i].FirstRow;
                Rows += pages[i].Rows;
            }
            slots = Math.Clamp(slots, 1, Math.Max(1, pages.Length));
            slotPages = new int[slots];
            Array.Fill(slotPages, -1);
            slotLayouts = new int[slots][];
            slotBlobStarts = new int[slots];
        }

        public long Rows { get; }

        /// <summary>The bytes of the layouts kept now.</summary>
        public long LayoutBytes => slotLayouts.Sum(layout => 4L * (layout?.Length ?? 0));

        public PageView ViewOf(long row, out int local)
        {
            var index = Array.BinarySearch(starts, row);
            if (index < 0) index = ~index - 1;
            var page = pages[index];
            var slot = index % slotPages.Length;
            if (slotPages[slot] != index)
            {
                var parsed = PageView.Parse(page.Body, columns, slotLayouts[slot]);
                slotLayouts[slot] = parsed.Layout;
                slotBlobStarts[slot] = parsed.BlobStart;
                slotPages[slot] = index;
            }
            local = (int)(row - page.FirstRow);
            return PageView.At(page.Body, slotBlobStarts[slot], slotLayouts[slot]!, page.FirstRow, page.Rows, columns);
        }
    }
}
