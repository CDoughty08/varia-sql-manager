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
/// truncated cell is searched by its stored prefix, which makes the outcome Approximate. Hidden columns (row tone) are skipped.
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
    /// <summary>Work between checkpoints: each cell compared counts CellWork, its bytes and the text's length (a compare
    /// prepares the text each call, so a long text costs per cell even against short cells).</summary>
    internal const int CheckEvery = 1 << 16;
    private const int CellWork = 16;
    /// <summary>The most parsed page layouts (44 bytes per column each) a search through a view keeps at once.</summary>
    internal const int LayoutCacheBytes = 1 << 20;

    /// <summary>Whether a search must stop without an outcome: its result was released or its view closed.</summary>
    public static Func<bool> Stopped(ResultStore store, ResultSetBuffer set, ResultView? view) =>
        () => set.IsReleased || (view is not null && !store.HasView(view));

    /// <summary>The fewest positions a thread of a search reads; fewer than two of these are read on one.</summary>
    internal const int MinSlice = 1 << 15;

    /// <summary>What one run of positions found: its matches, and the ones a run of the outcome may take, in whole rows
    /// (forward the first from FromRow, backward the last before it, each to MaxMatches as the whole search keeps them).</summary>
    private sealed class Part
    {
        public long Total, Before;
        public bool Approximate, Stopped;
        public readonly List<long> Rows = [];
        public readonly List<int> Columns = [];
        /// <summary>Where each kept row's matches begin (backward only), from <see cref="Head"/>.</summary>
        public readonly List<int> RowStarts = [];
        public int Head, Start;
    }

    /// <summary>The positions are read in runs on several threads (one per <see cref="MinSlice"/> positions, up to the
    /// sort's threads, or <paramref name="workers"/>), each keeping what the outcome may take of it, joined in order: the
    /// outcome is the one a single pass gives.</summary>
    /// <returns>The outcome, or null when <paramref name="stopped"/> said so at a checkpoint (or the view names a row past
    /// <paramref name="pages"/>, which only a release that emptied them can cause).</returns>
    public static SearchOutcome? Search(ResultSetBuffer set, StoredPage[] pages, ResultView? view, string text, long fromRow, bool backward, int maxMatches, CancellationToken token, Func<bool>? stopped = null, int? workers = null, ViewSorter.WorkerGate? gate = null)
    {
        var columns = set.Wires.Count;
        using var pin = set.Pin();
        var matchers = new Matcher?[columns];
        // A hidden column (a diff's or live table's row tone) is not in the grid, so its text never matches.
        for (var c = 0; c < columns; c++) matchers[c] = ResultTextWriter.Hidden(set.Columns[c]) ? null : MatcherFor(set.Columns[c], set.Wires[c], text);
        long baseRows = 0;
        foreach (var page in pages) baseRows += page.Rows;
        long rows = view?.Rows ?? baseRows;
        // A run for each thread asked for, read on the share of the threads the gate gives. A run is one item, so a search
        // holding more than its share gives a thread back only as one of its runs ends (each keeps matches of its own).
        using var threads = (gate ?? ViewSorter.Gate).Take((int)Math.Max(1, workers ?? Math.Min(rows / MinSlice, ViewSorter.Workers)));
        var runs = (int)Math.Clamp(threads.Wanted, 1, Math.Max(1, Math.Min(rows, int.MaxValue)));
        var parts = new Part[runs];
        long From(int run) => rows * run / runs;
        var slots = view is null ? 1 : Math.Max(1, LayoutCacheBytes / (4 * PageView.ScratchLength(Math.Max(1, columns))) / runs);
        void Read(int run)
        {
            var part = parts[run] = new Part();
            Scan(part, new Source(pages, columns, slots), view, matchers, From(run), From(run + 1), text.Length, fromRow, backward, maxMatches, token, stopped);
        }
        threads.For(runs, Read);
        long total = 0, before = 0, first = -1;
        var approximate = false;
        var keptRows = new List<long>();
        var keptColumns = new List<int>();
        var rowStarts = new List<int>();
        foreach (var part in parts)
        {
            if (part.Stopped) return null;
            approximate |= part.Approximate;
            before += part.Before;
            if (!backward)
            {
                // A run's kept matches are its first from FromRow: the ones before them in it are those before FromRow.
                if (first < 0 && part.Rows.Count > 0) first = total + part.Before;
                for (var i = 0; i < part.Rows.Count && keptRows.Count < maxMatches;)
                {
                    var row = part.Rows[i];
                    for (; i < part.Rows.Count && part.Rows[i] == row; i++) { keptRows.Add(row); keptColumns.Add(part.Columns[i]); }
                }
            }
            else
            {
                for (var i = part.Start; i < part.Rows.Count; i++)
                {
                    if (i == part.Start || part.Rows[i] != part.Rows[i - 1]) rowStarts.Add(keptRows.Count);
                    keptRows.Add(part.Rows[i]);
                    keptColumns.Add(part.Columns[i]);
                }
            }
            total += part.Total;
        }
        if (!backward) return new SearchOutcome(rows, total, first < 0 ? total : first, [.. keptRows], [.. keptColumns], approximate);
        // The oldest rows go while the rows after them still hold maxMatches.
        var head = 0;
        while (rowStarts.Count - head > 1 && keptRows.Count - rowStarts[head + 1] >= maxMatches) head++;
        var start = rowStarts.Count == 0 ? 0 : rowStarts[head];
        var kept = keptRows.Count - start;
        return new SearchOutcome(rows, total, before - kept, keptRows.GetRange(start, kept).ToArray(), keptColumns.GetRange(start, kept).ToArray(), approximate);
    }

    private static void Scan(Part part, Source source, ResultView? view, Matcher?[] matchers, long from, long to, int textLength, long fromRow, bool backward, int maxMatches, CancellationToken token, Func<bool>? stopped)
    {
        var columns = matchers.Length;
        var found = new List<int>(16);
        var scratch = new Scratch();
        long work = 0;
        var cellWork = CellWork + textLength;
        for (var position = from; position < to; position++)
        {
            if (work <= 0)
            {
                token.ThrowIfCancellationRequested();
                if (stopped?.Invoke() == true) { part.Stopped = true; return; }
                work = CheckEvery;
            }
            var row = view is null ? position : view.Order[position];
            if (row >= source.Rows) { part.Stopped = true; return; }
            var page = source.ViewOf(row, out var local);
            found.Clear();
            work -= CellWork;
            for (var c = 0; c < columns; c++)
            {
                if (matchers[c] is not { } matcher || page.IsNull(c, local)) continue;
                var truncated = page.IsTruncated(c, local);
                var cell = page.Span(c, local);
                work -= cellWork + cell.Length;
                if (matcher.Matches(cell, scratch)) found.Add(c);
                else if (truncated) part.Approximate = true;
            }
            if (found.Count == 0) continue;
            part.Total += found.Count;
            if (position < fromRow) part.Before += found.Count;
            if (!backward)
            {
                if (position >= fromRow && part.Rows.Count < maxMatches)
                    foreach (var c in found) { part.Rows.Add(position); part.Columns.Add(c); }
            }
            else if (position < fromRow)
            {
                part.RowStarts.Add(part.Rows.Count);
                foreach (var c in found) { part.Rows.Add(position); part.Columns.Add(c); }
                // Drop the oldest row while the rows after it still hold maxMatches.
                while (part.RowStarts.Count - part.Head > 1 && part.Rows.Count - part.RowStarts[part.Head + 1] >= maxMatches) part.Head++;
                part.Start = part.RowStarts[part.Head];
                if (part.Start > 4096 && part.Start > part.Rows.Count / 2) Compact(part.Rows, part.Columns, part.RowStarts, ref part.Head, ref part.Start);
            }
        }
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
        private readonly byte[]?[] slotBodies;
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
            slotBodies = new byte[slots][];
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
                var body = slotBodies[slot] = page.Body();
                var parsed = PageView.Parse(body, columns, slotLayouts[slot]);
                slotLayouts[slot] = parsed.Layout;
                slotBlobStarts[slot] = parsed.BlobStart;
                slotPages[slot] = index;
            }
            local = (int)(row - page.FirstRow);
            return PageView.At(slotBodies[slot]!, slotBlobStarts[slot], slotLayouts[slot]!, page.FirstRow, page.Rows, columns);
        }
    }
}
