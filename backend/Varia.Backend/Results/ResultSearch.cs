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
        /// <summary>Elsewhere: a truncated cell did not match in a row that neither matched nor needs a recheck.</summary>
        public bool Approximate, Stopped, Elsewhere;
        /// <summary>Positions a narrowed search passed over in this run.</summary>
        public long Skipped;
        public readonly List<long> Rows = [];
        public readonly List<int> Columns = [];
        /// <summary>Where each kept row's matches begin (backward only), from <see cref="Head"/>.</summary>
        public readonly List<int> RowStarts = [];
        public int Head, Start;
    }

    /// <summary>How the calling thread's last search used the one before it (<see cref="Narrowing.Repeated"/>), for the checks.</summary>
    [ThreadStatic] internal static bool? LastNarrowing;

    /// <summary>How many positions the calling thread's last search was offered to pass over, for the checks.</summary>
    [ThreadStatic] internal static long LastSkipped;

    /// <summary>The positions are read in runs on several threads (one per <see cref="MinSlice"/> positions, up to the
    /// sort's threads, or <paramref name="workers"/>), each keeping what the outcome may take of it, joined in order: the
    /// outcome is the one a single pass gives.</summary>
    /// <returns>The outcome, or null when <paramref name="stopped"/> said so at a checkpoint (or the view names a row past
    /// <paramref name="pages"/>, which only a release that emptied them can cause).</returns>
    /// <param name="narrow">Whether the search may read only the rows the result's last search kept (<see cref="SearchMemo"/>)
    /// and keep what it finds for the next; false searches every row and keeps nothing (the checks' reference).</param>
    public static SearchOutcome? Search(ResultSetBuffer set, StoredPage[] pages, ResultView? view, string text, long fromRow, bool backward, int maxMatches, CancellationToken token, Func<bool>? stopped = null, int? workers = null, ViewSorter.WorkerGate? gate = null, bool narrow = true)
    {
        var columns = set.Wires.Count;
        using var pin = set.Pin();
        var matchers = new Matcher?[columns];
        // A hidden column (a diff's or live table's row tone) is not in the grid, so its text never matches.
        for (var c = 0; c < columns; c++) matchers[c] = ResultTextWriter.Hidden(set.Columns[c]) ? null : MatcherFor(set.Columns[c], set.Wires[c], text);
        long baseRows = 0;
        foreach (var page in pages) baseRows += page.Rows;
        long rows = view?.Rows ?? baseRows;
        Narrowing? plan = null;
        try
        {
            plan = narrow ? Narrowing.Plan(set, view, text, matchers, rows) : null;
            LastNarrowing = plan?.Repeated;
            var found = Search(set, pages, view, matchers, baseRows, rows, text, fromRow, backward, maxMatches, token, stopped, workers, gate, plan);
            if (found is not null && plan is not null) found = plan.Finish(set, found);
            return found;
        }
        finally
        {
            LastSkipped = plan?.Skipped ?? 0;
            plan?.Dispose(set);
        }
    }

    private static SearchOutcome? Search(ResultSetBuffer set, StoredPage[] pages, ResultView? view, Matcher?[] matchers, long baseRows, long rows, string text, long fromRow, bool backward, int maxMatches, CancellationToken token, Func<bool>? stopped, int? workers, ViewSorter.WorkerGate? gate, Narrowing? plan)
    {
        var columns = matchers.Length;
        // A packed result is read fused: each run unpacks the pages it reaches into rooms of its own (two at most, as a run
        // reads base order or a view near it). Through a view far from its packed pages' order (a sort, not Local) it is read
        // in page order instead, each row placed at its view position (ByPages), so it is never unpacked whole; that reads
        // every base row, so its threads are sized by them, not by the view's rows.
        var byPages = view is not null && !Local(pages, view.Order, token);
        var read = byPages ? baseRows : rows;
        // A run for each thread asked for, read on the share of the threads the gate gives. A run is one item, so a search
        // holding more than its share gives a thread back only as one of its runs ends (each keeps matches of its own).
        using var threads = (gate ?? ViewSorter.Gate).Take((int)Math.Max(1, workers ?? Math.Min(read / MinSlice, ViewSorter.Workers)));
        if (byPages)
            return ByPages(set, pages, view!, matchers, baseRows, text.Length, fromRow, backward, maxMatches, token, stopped, threads, plan);
        var runs = (int)Math.Clamp(threads.Wanted, 1, Math.Max(1, Math.Min(rows, int.MaxValue)));
        var parts = new Part[runs];
        long From(int run) => rows * run / runs;
        using var rooms = PageRooms.Over(pages, columns, () => new RequestException("TOO_LARGE", TooLarge));
        var slots = view is null ? 1 : Math.Max(1, LayoutCacheBytes / (4 * PageView.ScratchLength(Math.Max(1, columns))) / runs);
        if (rooms is not null) slots = Math.Min(slots, PackedSlots);
        void Read(int run)
        {
            var part = parts[run] = new Part();
            using var source = new Source(pages, columns, slots, rooms);
            Scan(part, source, view, matchers, From(run), From(run + 1), text.Length, fromRow, backward, maxMatches, token, stopped, plan);
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
            if (plan is not null) { plan.Elsewhere |= part.Elsewhere; plan.Skipped += part.Skipped; }
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

    private static void Scan(Part part, Source source, ResultView? view, Matcher?[] matchers, long from, long to, int textLength, long fromRow, bool backward, int maxMatches, CancellationToken token, Func<bool>? stopped, Narrowing? plan)
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
            // A narrowed search passes over the rows the last search ruled out, up to a word of them at a time.
            if (plan is not null && plan.Skip(position) is var skip and > 0)
            {
                work--;
                part.Skipped += skip;
                position += skip - 1;
                continue;
            }
            var row = view is null ? position : view.Order[position];
            if (row >= source.Rows) { part.Stopped = true; return; }
            var page = source.ViewOf(row, out var local);
            found.Clear();
            work -= CellWork;
            bool recheck = false, missed = false;
            for (var c = 0; c < columns; c++)
            {
                if (matchers[c] is not { } matcher || page.IsNull(c, local)) continue;
                var truncated = page.IsTruncated(c, local);
                var cell = page.Span(c, local);
                work -= cellWork + cell.Length;
                var cellRecheck = false;
                if (plan is { Rechecks: true } ? matcher.Matches(cell, scratch, out cellRecheck) : matcher.Matches(cell, scratch)) found.Add(c);
                else
                {
                    if (truncated) part.Approximate = missed = true;
                    recheck |= cellRecheck;
                }
            }
            plan?.Mark(position, found.Count > 0, recheck);
            if (found.Count == 0)
            {
                if (missed && !recheck) part.Elsewhere = true;
                continue;
            }
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

    /// <summary>Searches a view far from its packed pages' order (a sort) by reading the result in page order, fused, each
    /// row placed at its view position through an inverse of the view's order (4 bytes a base row, reserved from the
    /// result's budget while it runs; TOO_LARGE without room). Each run keeps only the rows the outcome may take (the first
    /// from FromRow, or the last before it, in whole rows to MaxMatches, by view position), so the outcome is the one a pass
    /// in view order gives, with each packed page unpacked once a run instead of once a row.</summary>
    private static SearchOutcome? ByPages(ResultSetBuffer set, StoredPage[] pages, ResultView view, Matcher?[] matchers, long baseRows, int textLength, long fromRow, bool backward, int maxMatches, CancellationToken token, Func<bool>? stopped, ViewSorter.WorkerGate.Lease threads, Narrowing? plan)
    {
        var order = view.Order;
        var bytes = 4L * baseRows;
        if (baseRows > Array.MaxLength || !set.TryReserveWork(bytes)) throw new RequestException("TOO_LARGE", TooLarge);
        try
        {
            var at = GC.AllocateUninitializedArray<int>((int)baseRows);
            Array.Fill(at, -1);
            for (var position = 0; position < order.Length; position++)
            {
                if ((position & 0xFFFF) == 0) token.ThrowIfCancellationRequested();
                // A view naming a row past the pages: only a release that emptied them can cause it.
                if (order[position] >= baseRows) return null;
                at[order[position]] = position;
            }
            var runs = (int)Math.Clamp(threads.Wanted, 1, Math.Max(1, Math.Min(baseRows, int.MaxValue)));
            var parts = new Kept[runs];
            long From(int run) => baseRows * run / runs;
            using var rooms = PageRooms.Over(pages, matchers.Length, () => new RequestException("TOO_LARGE", TooLarge));
            void Read(int run)
            {
                var part = parts[run] = new Kept(backward, maxMatches);
                using var source = new Source(pages, matchers.Length, PackedSlots, rooms);
                ScanPages(part, source, at, matchers, From(run), From(run + 1), textLength, fromRow, token, stopped, plan);
            }
            threads.For(runs, Read);
            long total = 0, before = 0;
            var approximate = false;
            List<(long Position, int[] Columns)> rows = [];
            foreach (var part in parts)
            {
                if (part.Stopped) return null;
                total += part.Total;
                before += part.Before;
                approximate |= part.Approximate;
                if (plan is not null) { plan.Elsewhere |= part.Elsewhere; plan.Skipped += part.Skipped; }
                rows.AddRange(part.Rows);
            }
            rows.Sort((a, b) => a.Position.CompareTo(b.Position));
            // Forward the first rows from FromRow until they hold maxMatches; backward the last before it, the oldest going
            // while the rows after them still hold maxMatches.
            var take = 0;
            var count = 0;
            if (!backward) for (; take < rows.Count && count < maxMatches; take++) count += rows[take].Columns.Length;
            else for (; take < rows.Count && count < maxMatches; take++) count += rows[rows.Count - 1 - take].Columns.Length;
            var chosen = backward ? rows.GetRange(rows.Count - take, take) : rows.GetRange(0, take);
            var keptRows = new long[count];
            var keptColumns = new int[count];
            var k = 0;
            foreach (var (position, columns) in chosen)
                foreach (var column in columns) { keptRows[k] = position; keptColumns[k++] = column; }
            var first = backward ? before - count : count == 0 ? total : before;
            return new SearchOutcome(order.Length, total, first, keptRows, keptColumns, approximate);
        }
        finally { set.ReturnWork(bytes); }
    }

    /// <summary>What one run of a page-order search found: its matches, and the rows the outcome may take, by view position
    /// (a heap whose top is the row to give up first: the last forward, the first backward).</summary>
    private sealed class Kept(bool backward, int maxMatches)
    {
        public long Total, Before;
        public bool Approximate, Stopped, Elsewhere;
        public long Skipped;
        public bool Backward => backward;
        private readonly PriorityQueue<(long Position, int[] Columns), long> heap = new();
        private int count;
        public IEnumerable<(long Position, int[] Columns)> Rows => heap.UnorderedItems.Select(item => item.Element);

        /// <summary>Whether a row at this position would be given up at once, so it need not be kept.</summary>
        public bool Beyond(long position) =>
            count >= maxMatches && heap.TryPeek(out var top, out _) && (backward ? position < top.Position : position > top.Position);

        public void Add(long position, List<int> found)
        {
            heap.Enqueue((position, [.. found]), backward ? position : -position);
            count += found.Count;
            while (heap.Count > 1 && heap.TryPeek(out var top, out _) && count - top.Columns.Length >= maxMatches)
            {
                heap.Dequeue();
                count -= top.Columns.Length;
            }
        }
    }

    private static void ScanPages(Kept part, Source source, int[] at, Matcher?[] matchers, long from, long to, int textLength, long fromRow, CancellationToken token, Func<bool>? stopped, Narrowing? plan)
    {
        var columns = matchers.Length;
        var found = new List<int>(16);
        var scratch = new Scratch();
        long work = 0;
        var cellWork = CellWork + textLength;
        for (var row = from; row < to; row++)
        {
            if (work <= 0)
            {
                token.ThrowIfCancellationRequested();
                if (stopped?.Invoke() == true) { part.Stopped = true; return; }
                work = CheckEvery;
            }
            // A row the view leaves out (filtered) is not searched.
            work -= 1;
            var position = at[row];
            // A row the last search ruled out is not read: a page holding none of the rest is never unpacked.
            if (position < 0) continue;
            if (plan is not null && plan.Skip(position) > 0) { part.Skipped++; continue; }
            var page = source.ViewOf(row, out var local);
            found.Clear();
            work -= CellWork;
            bool recheck = false, missed = false;
            for (var c = 0; c < columns; c++)
            {
                if (matchers[c] is not { } matcher || page.IsNull(c, local)) continue;
                var truncated = page.IsTruncated(c, local);
                var cell = page.Span(c, local);
                work -= cellWork + cell.Length;
                var cellRecheck = false;
                if (plan is { Rechecks: true } ? matcher.Matches(cell, scratch, out cellRecheck) : matcher.Matches(cell, scratch)) found.Add(c);
                else
                {
                    if (truncated) part.Approximate = missed = true;
                    recheck |= cellRecheck;
                }
            }
            plan?.Mark(position, found.Count > 0, recheck);
            if (found.Count == 0)
            {
                if (missed && !recheck) part.Elsewhere = true;
                continue;
            }
            part.Total += found.Count;
            if (position < fromRow) part.Before += found.Count;
            if (part.Backward ? position >= fromRow : position < fromRow) continue;
            if (!part.Beyond(position)) part.Add(position, found);
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
                return new CultureMatcher(text, culture.Info, culture.Options, SearchFold.For(collation.Lcid, culture.Options));
            return new OrdinalMatcher(text, (collation.Options & 1) != 0 ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
        }
        return new OrdinalMatcher(text, StringComparison.OrdinalIgnoreCase);
    }

    internal sealed class Scratch
    {
        public char[] Chars = new char[256];
        /// <summary>A cell's fold (<see cref="SearchFold"/>), for the pre-check before a culture compare.</summary>
        public char[] Folded = new char[256];

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
        /// <summary>How it compares, for narrowing (<see cref="SearchNarrowing"/>).</summary>
        public abstract SearchNarrowing.Kind Kind { get; }
        /// <summary>Matches, and for a cell it did not match, whether a longer text narrowing from this one must look at the
        /// cell again (<see cref="SearchNarrowing"/>): never after an ordinal or hex compare.</summary>
        public virtual bool Matches(ReadOnlySpan<byte> cell, Scratch scratch, out bool recheck)
        {
            recheck = false;
            return Matches(cell, scratch);
        }

        /// <summary>What a later text must meet to narrow from the cells this matcher ruled out
        /// (<see cref="SearchNarrowing.Needs"/>): nothing after an ordinal or hex compare.</summary>
        public virtual SearchNarrowing.Needs Needs => SearchNarrowing.Needs.None;
    }

    private sealed class OrdinalMatcher(string text, StringComparison comparison) : Matcher
    {
        public override SearchNarrowing.Kind Kind => comparison == StringComparison.Ordinal ? SearchNarrowing.Kind.Ordinal : SearchNarrowing.Kind.OrdinalIgnoreCase;
        public override bool Matches(ReadOnlySpan<byte> cell, Scratch scratch) => scratch.Decode(cell).Contains(text, comparison);
    }

    /// <summary>A culture compare (ICU), about 90 MB/s on text that is not ASCII. With the culture's fold, a cell whose fold
    /// does not hold the text's fold as an ordinal substring cannot hold the text, so it is ruled out without the compare
    /// (about 3.3 times faster over SQL Server's messages in 22 languages); the compare judges the rest. A cell the fold cannot vouch for goes
    /// to the compare alone. When most cells pass the pre-check anyway (a common word), it only adds work, so after
    /// <see cref="PrecheckSample"/> cells the matcher stops pre-checking if more than <see cref="PrecheckKeep"/> of them
    /// passed.</summary>
    internal sealed class CultureMatcher : Matcher
    {
        private readonly string text;
        private readonly CompareInfo info;
        private readonly CompareOptions options;
        private readonly SearchFold? fold;
        private readonly string? folded;
        // Counted while sampling only (shared by the search's threads), then one decision: 0 sampling, 1 pre-check, 2 not.
        private int sampled, passed, mode;

        public CultureMatcher(string text, CompareInfo info, CompareOptions options, SearchFold? fold)
        {
            this.text = text;
            this.info = info;
            this.options = options;
            folded = fold?.FoldText(text);
            this.fold = folded is null ? null : fold;
            asciiText = Ascii.IsValid(text);
        }

        public override SearchNarrowing.Kind Kind => SearchNarrowing.Kind.Culture;

        /// <summary>The text's fold, when the pre-check runs.</summary>
        public string? Folded => folded;

        /// <summary>Pre-checks every cell, never stopping for the sampling: a narrowed search, whose rows mostly pass, needs
        /// the pre-check's answer to keep ruling rows out.</summary>
        internal bool KeepPrechecking { get; set; }

        public override SearchNarrowing.Needs Needs =>
            (Volatile.Read(ref ruledByFold) ? SearchNarrowing.Needs.Fold : 0) | (Volatile.Read(ref ruledByAscii) ? SearchNarrowing.Needs.Ascii : 0);
        private bool ruledByFold, ruledByAscii;
        private bool? narrowsAscii;
        private readonly bool asciiText;

        /// <summary>A cell it did not match is ruled out for a longer text when its fold lacked this text's fold (the
        /// pre-check, while it runs: a text whose fold holds this one's is then not in it either), or when the cell and the
        /// text are pure ASCII and the culture joins no two ASCII characters (<see cref="SearchNarrowing.SafeCulture"/>);
        /// any other is looked at again. Which rule ruled cells out is kept (<see cref="Needs"/>).</summary>
        public override bool Matches(ReadOnlySpan<byte> cell, Scratch scratch, out bool recheck)
        {
            var chars = default(ReadOnlySpan<char>);
            recheck = false;
            if (fold is not null && (KeepPrechecking || Volatile.Read(ref mode) != 2))
            {
                int length;
                var vouched = fold.TryFoldAscii(cell, ref scratch.Folded, out length)
                    || fold.TryFold(chars = scratch.Decode(cell), ref scratch.Folded, out length);
                var maybe = !vouched || scratch.Folded.AsSpan(0, length).IndexOf(folded.AsSpan(), StringComparison.Ordinal) >= 0;
                if (!KeepPrechecking && Volatile.Read(ref mode) == 0) Sample(maybe);
                if (!maybe)
                {
                    if (!ruledByFold) Volatile.Write(ref ruledByFold, true);
                    return false;
                }
            }
            if (info.IndexOf(chars.IsEmpty && cell.Length > 0 ? scratch.Decode(cell) : chars, text, options) >= 0) return true;
            if (asciiText && Ascii.IsValid(cell) && (narrowsAscii ??= SearchNarrowing.SafeCulture(info, options)))
            {
                if (!ruledByAscii) Volatile.Write(ref ruledByAscii, true);
                return false;
            }
            recheck = true;
            return false;
        }

        /// <summary>Whether the pre-check runs: the culture's fold was ready and the text folds.</summary>
        public bool Prechecks => fold is not null && Volatile.Read(ref mode) != 2;

        public override bool Matches(ReadOnlySpan<byte> cell, Scratch scratch)
        {
            if (fold is null || Volatile.Read(ref mode) == 2) return info.IndexOf(scratch.Decode(cell), text, options) >= 0;
            var chars = default(ReadOnlySpan<char>);
            int length;
            var vouched = fold.TryFoldAscii(cell, ref scratch.Folded, out length)
                || fold.TryFold(chars = scratch.Decode(cell), ref scratch.Folded, out length);
            var maybe = !vouched || scratch.Folded.AsSpan(0, length).IndexOf(folded.AsSpan(), StringComparison.Ordinal) >= 0;
            if (Volatile.Read(ref mode) == 0) Sample(maybe);
            if (!maybe) return false;
            return info.IndexOf(chars.IsEmpty && cell.Length > 0 ? scratch.Decode(cell) : chars, text, options) >= 0;
        }

        private void Sample(bool maybe)
        {
            if (maybe) Interlocked.Increment(ref passed);
            if (Interlocked.Increment(ref sampled) != PrecheckSample) return;
            Volatile.Write(ref mode, Volatile.Read(ref passed) > PrecheckSample * PrecheckKeep ? 2 : 1);
        }
    }

    /// <summary>Cells a culture matcher pre-checks before it decides whether pre-checking pays.</summary>
    internal const int PrecheckSample = 1024;

    /// <summary>The share of sampled cells passing the pre-check above which it stops: the pre-check costs about a fifth
    /// of a compare, so with most cells passing it only adds work.</summary>
    internal const double PrecheckKeep = 0.6;

    private sealed class HexMatcher(string text) : Matcher
    {
        public override SearchNarrowing.Kind Kind => SearchNarrowing.Kind.Hex;
        public override bool Matches(ReadOnlySpan<byte> cell, Scratch scratch) => scratch.Hex(cell).Contains(text, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>What a search answers (TOO_LARGE) when the budget has no room for the rooms a packed result is read through,
    /// or, through a view far from its pages' order, for the view's inverse (ByPages).</summary>
    public const string TooLarge = "There is not enough result memory to search these rows. Close other results and try again.";

    /// <summary>Slots a run keeps when the result is packed: each holds a room, and a run reads its pages in order.</summary>
    internal const int PackedSlots = 2;

    /// <summary>Unpacks a fused search through a view may make per packed page, with <see cref="PackedSlots"/> slots,
    /// before the search reads the result in page order instead (ByPages).</summary>
    internal const int UnpacksPerPage = 4;

    /// <summary>Whether a search through a view of this order would read the packed pages in about their order: with
    /// <see cref="PackedSlots"/> direct-mapped slots, at most <see cref="UnpacksPerPage"/> unpacks a packed page (rows past
    /// the pages skipped). A filter of a result in its own order is; a sort is not. Counted from the row numbers alone, and
    /// stopped once past the allowance. The caller holds the set's pin.</summary>
    public static bool Local(StoredPage[] pages, int[] order, CancellationToken token = default)
    {
        var starts = new long[pages.Length];
        var packed = new bool[pages.Length];
        long packedPages = 0, rows = 0;
        for (var i = 0; i < pages.Length; i++)
        {
            starts[i] = pages[i].FirstRow;
            rows += pages[i].Rows;
            if (pages[i].Set is { } set && set.Raw(pages[i]) is null) { packed[i] = true; packedPages++; }
        }
        if (packedPages == 0) return true;
        var allowed = UnpacksPerPage * packedPages + PackedSlots;
        Span<int> held = stackalloc int[PackedSlots];
        held.Fill(-1);
        long unpacks = 0;
        var counter = 0;
        foreach (var row in order)
        {
            if (++counter == 1 << 16) { counter = 0; token.ThrowIfCancellationRequested(); }
            if (row >= rows) continue;
            var index = Array.BinarySearch(starts, (long)row);
            if (index < 0) index = ~index - 1;
            if (!packed[index] || held[index % PackedSlots] == index) continue;
            held[index % PackedSlots] = index;
            if (++unpacks > allowed) return false;
        }
        return true;
    }

    /// <summary>The sealed pages a search reads, a row's page found by binary search and parsed when reached, its layout kept
    /// in one of a few slots (direct-mapped by page index) so a wide result's layouts never outgrow the cache. With rooms, a
    /// packed page is unpacked into its slot's own room (fused); disposing the source gives the rooms back.</summary>
    internal sealed class Source : IDisposable
    {
        private readonly StoredPage[] pages;
        private readonly long[] starts;
        private readonly int[] slotPages;
        private readonly int[]?[] slotLayouts;
        private readonly byte[]?[] slotBodies;
        private readonly int[] slotBlobStarts;
        private readonly PageRoom?[] slotRooms;
        private readonly PageRooms? rooms;
        private readonly int columns;

        public Source(StoredPage[] pages, int columns, int slots, PageRooms? rooms = null)
        {
            this.pages = pages;
            this.columns = columns;
            this.rooms = rooms;
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
            slotRooms = new PageRoom?[slots];
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
                slotPages[slot] = -1;
                byte[] body;
                if (rooms is not null && page.Set is { } set && set.Raw(page) is null) body = set.Read(page, (slotRooms[slot] ??= rooms.Rent()).Bytes);
                else body = page.Body();
                slotBodies[slot] = body;
                var parsed = PageView.Parse(body.AsSpan(0, page.Length), columns, slotLayouts[slot]);
                slotLayouts[slot] = parsed.Layout;
                slotBlobStarts[slot] = parsed.BlobStart;
                slotPages[slot] = index;
            }
            local = (int)(row - page.FirstRow);
            return PageView.At(slotBodies[slot].AsSpan(0, page.Length), slotBlobStarts[slot], slotLayouts[slot]!, page.FirstRow, page.Rows, columns);
        }

        public void Dispose()
        {
            for (var i = 0; i < slotRooms.Length; i++)
            {
                slotRooms[i]?.Dispose();
                slotRooms[i] = null;
            }
        }
    }
}
