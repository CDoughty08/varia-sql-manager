using System.Text;

namespace Varia.Backend.Results;

/// <summary>How a distinct snapshot lists a column's values: most frequent first (ties by value), or by value as the sort
/// orders them.</summary>
internal enum DistinctOrder { Count, Value }

/// <summary>
/// A column's distinct values over a view's rows (or the sealed rows), kept for the header funnel's checklist
/// (results.distinct): the groups in value order (each its representative base row, the lowest holding it, and its count),
/// their count order, the checklist's tick for each value and for NULL, and the last search's matching groups in both
/// orders. Windows of it are read (results.distinctRead) and ticked (results.distinctTick) by group, and a <c>groups</c>
/// view filter keeps or drops the rows of the values it ticks; the first such filter freezes it, so a view built again
/// keeps the same rows. Its memory (<see cref="ViewSorter.DistinctSnapshotBytes"/>) is charged to the result's query budget
/// and returned when it is closed or its result released. The ticks have a lock of their own, held only briefly, so
/// freezing (which a results.view does before it builds) never waits for a search; a search's scan holds the search lock,
/// and its matches, once found, never change. The groups never change once built.
/// </summary>
internal sealed class DistinctSnapshot
{
    private readonly object gate = new();
    private readonly object searching = new();
    private readonly ViewSorter.PageSource source;
    private readonly int[] reps, counts, byCount;
    private readonly bool[] ticks;
    private int ticked;
    private bool nullTicked;
    private (FilterOp Op, int[] Rows, bool Nulls)? frozen;
    private (string Text, int[] ByValue, int[] ByCount)? lastSearch;

    internal DistinctSnapshot(ResultSetBuffer set, int column, ViewSorter.PageSource source, int[] reps, int[] counts, int[] byCount, bool[] ticks, long rows, long nulls, bool nullTicked, bool complete, bool approximate)
    {
        Set = set;
        Column = column;
        this.source = source;
        this.reps = reps;
        this.counts = counts;
        this.byCount = byCount;
        this.ticks = ticks;
        foreach (var tick in ticks) if (tick) ticked++;
        Rows = rows;
        Nulls = nulls;
        this.nullTicked = nullTicked;
        Complete = complete;
        Approximate = approximate;
    }

    public uint SnapshotId { get; internal set; }
    public ResultSetBuffer Set { get; }
    public int Column { get; }
    /// <summary>Rows grouped (the view's, or the rows sealed when it was built).</summary>
    public long Rows { get; }
    /// <summary>NULL and unreadable cells among them, never a value.</summary>
    public long Nulls { get; }
    public int Distinct => reps.Length;
    /// <summary>The rows grouped were every row of a finished set: no value can arrive later.</summary>
    public bool Complete { get; }
    /// <summary>A truncated value compared by its stored prefix.</summary>
    public bool Approximate { get; }
    internal long Charged { get; set; }
    /// <summary>The search lock, for checks that hold it while freezing.</summary>
    internal object SearchLock => searching;

    public (int Checked, bool NullChecked) Ticks { get { lock (gate) return (ticked, nullTicked); } }

    /// <summary>Up to <paramref name="count"/> values from <paramref name="offset"/> in the order asked, among those whose
    /// display text contains <paramref name="search"/> when given, each as results.distinctRead answers it; <c>Total</c>
    /// counts those values.</summary>
    public (int Total, DistinctValue[] Values, int Checked, bool NullChecked) Read(DistinctOrder order, int offset, int count, string? search, CancellationToken token)
    {
        var list = search is null ? (order == DistinctOrder.Count ? byCount : null) : order == DistinctOrder.Count ? Matches(search, token).ByCount : Matches(search, token).ByValue;
        var total = list?.Length ?? reps.Length;
        var take = Math.Max(0, Math.Min(count, total - offset));
        var values = new DistinctValue[take];
        var wire = Set.Wires[Column];
        // The display texts read the pages, which only the search lock's holders also read.
        lock (searching)
            for (var i = 0; i < take; i++)
            {
                var group = list?[offset + i] ?? offset + i;
                values[i] = new DistinctValue(group, reps[group], ViewSorter.Display(source, reps[group], Column, wire), counts[group], false);
            }
        lock (gate)
        {
            for (var i = 0; i < take; i++) values[i] = values[i] with { Checked = ticks[values[i].Group] };
            return (total, values, ticked, nullTicked);
        }
    }

    /// <summary>Ticks or clears the groups named, or every value (those matching <paramref name="search"/> with one), and
    /// NULL when <paramref name="nulls"/> says; INVALID_PARAMS for a group it does not have or once a filter froze it.</summary>
    public (int Checked, bool NullChecked) Tick(bool check, int[]? groups, bool all, string? search, bool? nulls, CancellationToken token)
    {
        if (groups is not null && groups.Any(group => group < 0 || group >= reps.Length))
            throw new RequestException("INVALID_PARAMS", "A value to tick is not one of the list's.");
        // A search's matches are found before the ticks' lock is taken.
        var matched = all && search is not null ? Matches(search, token).ByValue : null;
        lock (gate)
        {
            if (frozen is not null) throw new RequestException("INVALID_PARAMS", "These values already filter the grid. Open the column's filter again to change them.");
            if (all && search is null)
            {
                Array.Fill(ticks, check);
                ticked = check ? reps.Length : 0;
            }
            else
            {
                foreach (var group in matched ?? groups ?? [])
                {
                    if (ticks[group] == check) continue;
                    ticks[group] = check;
                    ticked += check ? 1 : -1;
                }
            }
            if (nulls is { } tick) nullTicked = tick;
            return (ticked, nullTicked);
        }
    }

    /// <summary>The filter its ticks make, fixed from the first call on: <c>In</c> with the ticked values' rows when the
    /// snapshot saw every row and they are no more than the cleared ones, else <c>NotIn</c> with the cleared ones (so values
    /// in rows that arrive later stay shown); the rows are in value order, one a value, as a filter's own resolve to. NULL is
    /// among them only when the snapshot saw a NULL.</summary>
    public (FilterOp Op, int[] Rows, bool Nulls) Freeze()
    {
        lock (gate)
        {
            if (frozen is { } done) return done;
            var keep = Complete && ticked <= reps.Length - ticked;
            var rows = new int[keep ? ticked : reps.Length - ticked];
            for (int group = 0, at = 0; group < reps.Length; group++)
                if (ticks[group] == keep) rows[at++] = reps[group];
            // NULL is named only when the snapshot saw one: an entry never shown was never cleared, so NULLs that arrive later stay.
            frozen = (keep ? FilterOp.In : FilterOp.NotIn, rows, (keep ? nullTicked : !nullTicked) && Nulls > 0);
            return frozen.Value;
        }
    }

    /// <summary>The groups whose display text contains the search, in value order and in count order, kept until another
    /// search; found under the search lock, never the ticks'.</summary>
    private (int[] ByValue, int[] ByCount) Matches(string search, CancellationToken token)
    {
        lock (searching)
        {
            if (lastSearch is { } last && last.Text == search) return (last.ByValue, last.ByCount);
            var matcher = ResultSearcher.MatcherFor(Set.Columns[Column], Set.Wires[Column], search);
            var scratch = new ResultSearcher.Scratch();
            var hit = new bool[reps.Length];
            var found = 0;
            for (var group = 0; group < reps.Length; group++)
            {
                if ((group & (ViewSorter.CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                if (matcher is not null && matcher.Matches(source.Cell(reps[group], Column), scratch)) { hit[group] = true; found++; }
            }
            var byValue = new int[found];
            var ranked = new int[found];
            for (int group = 0, at = 0; group < reps.Length; group++) if (hit[group]) byValue[at++] = group;
            for (int i = 0, at = 0; i < byCount.Length; i++) if (hit[byCount[i]]) ranked[at++] = byCount[i];
            lastSearch = (search, byValue, ranked);
            return (byValue, ranked);
        }
    }
}

/// <summary>Where one distinct list's time went, for the result-work benchmark (--result-work-bench): Stopwatch ticks spent
/// building the column's key, picking the rows (and the kept view's marks), grouping without sorting (tried first while the
/// key's codes are its values), sorting, finding the runs of equal values and ranking them by count. Times only.</summary>
internal sealed class DistinctStages
{
    public long Key, Rows, Grouping, Sorting, Runs, Ranking;
}

internal static partial class ViewSorter
{
    /// <summary>Values one results.distinctRead answers and groups one results.distinctTick names (limits.distinct.maxWindow).</summary>
    public const int MaxDistinctWindow = 512;
    /// <summary>Distinct snapshots one result keeps at most (limits.distinct.maxSnapshots): a grid's filters and an open
    /// popover's list.</summary>
    public const int MaxDistinctSnapshots = 24;
    /// <summary>Characters of a value's display text returned (limits.distinct.valueChars); a longer one ends in "…".</summary>
    public const int DistinctValueChars = 256;

    /// <summary>What building a distinct snapshot holds while it runs, charged to the result's budget: the column's key (as a
    /// filter's, 16 bytes a row and a NULL bit), the rows it groups (4 bytes a row), up to one group a row (a count, a kept
    /// mark and a tick, 6 bytes), a kept view's row marks (1 byte a row), and the snapshot it keeps, at most one group a row
    /// (<see cref="DistinctSnapshotBytes"/>).</summary>
    public static long DistinctWorkingBytes(long rows) => WorkingBytes(rows, 1) + 11L * rows + DistinctSnapshotBytes(rows);

    /// <summary>What a snapshot of <paramref name="groups"/> values keeps: its representative rows, counts and count order
    /// (4 bytes each a group), its ticks (1), a search's matches in both orders and their marks (9), and a frozen filter's
    /// rows (4): 26 bytes a group, and its bookkeeping.</summary>
    public static long DistinctSnapshotBytes(long groups) => 26L * groups + 4096;

    /// <summary>
    /// A column's distinct values over a view's rows (or the sealed rows), each with its count and representative base row:
    /// the lowest base row holding it, so a filter by those rows compares exactly these values. Values are equal as a filter
    /// compares them (<see cref="Build(ResultSetBuffer, StoredPage[], IReadOnlyList{ViewKey}, IReadOnlyList{ViewFilter},
    /// CancellationToken)"/>): the column's collation decides which texts are one value, and a truncated value compares by
    /// its stored prefix (Approximate). NULL and unreadable cells are counted apart. Each value starts ticked, or with
    /// <paramref name="kept"/>, another view of the result, ticked when a row of that view holds it (equal as above), so a
    /// checklist over one view starts as a filtered view shows it; NULL likewise.
    /// </summary>
    public static DistinctSnapshot DistinctValues(ResultSetBuffer set, StoredPage[] pages, ResultView? view, int column, bool complete, CancellationToken token, ResultView? kept = null, KeyMemory? memory = null, DistinctStages? stages = null)
    {
        try { return DistinctValues(set, pages, view, column, complete, kept, memory, stages, token); }
        finally { memory?.ReturnAll(); }
    }

    private static DistinctSnapshot DistinctValues(ResultSetBuffer set, StoredPage[] pages, ResultView? view, int column, bool complete, ResultView? kept, KeyMemory? memory, DistinctStages? stages, CancellationToken token)
    {
        var lap = System.Diagnostics.Stopwatch.GetTimestamp();
        long Lap()
        {
            var now = System.Diagnostics.Stopwatch.GetTimestamp();
            var ticks = now - lap;
            lap = now;
            return ticks;
        }
        long total = 0;
        foreach (var page in pages) total += page.Rows;
        if (total > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to list its values.");
        var rows = (int)total;
        var source = new PageSource(pages, set.Wires.Count);
        var approximate = false;
        var key = Build(set, source, new ViewKey(column, false, SortMode.Value), null, rows, token, ref approximate, memory);
        if (stages is not null) stages.Key += Lap();
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
        // The kept view's rows. Rows sealed after it was built (a set still loading) count as kept: that view has not judged
        // them, and its rebuild may show them.
        bool[]? marks = null;
        var nullTicked = true;
        if (kept is not null)
        {
            marks = new bool[rows];
            nullTicked = false;
            for (var i = 0; i < kept.Order.Length; i++)
            {
                if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var row = kept.Order[i];
                if (row >= rows) continue;
                marks[row] = true;
                if (key.IsNull(row)) nullTicked = true;
            }
            for (var row = (int)Math.Min(kept.BaseRows, rows); row < rows; row++)
            {
                if ((row & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                marks[row] = true;
                if (key.IsNull(row)) nullTicked = true;
            }
        }
        if (stages is not null) stages.Rows += Lap();
        if (key.Coded && Grouped(key, values, count, marks, token) is { } grouped)
        {
            token.ThrowIfCancellationRequested();
            if (stages is not null) stages.Grouping += Lap();
            var codedRanks = ByCount(grouped.Counts);
            if (stages is not null) stages.Ranking += Lap();
            return new DistinctSnapshot(set, column, source, grouped.Reps, grouped.Counts, codedRanks, grouped.Ticks, looked, nulls, nullTicked, complete, approximate);
        }
        if (stages is not null) stages.Grouping += Lap();
        // Ties fall back to the base row, so each run of equal values starts with the lowest row holding it.
        ThrowIfSlow([key], values.AsSpan(0, count));
        Sort(values, 0, count, new Comparer([key], null, token));
        if (stages is not null) stages.Sorting += Lap();
        var (reps, counts, ticks) = Runs(key, values, count, marks, token);
        token.ThrowIfCancellationRequested();
        if (stages is not null) stages.Runs += Lap();
        var ranks = ByCount(counts);
        if (stages is not null) stages.Ranking += Lap();
        return new DistinctSnapshot(set, column, source, reps, counts, ranks, ticks, looked, nulls, nullTicked, complete, approximate);
    }

    /// <summary>The groups, most frequent first: a group's place in value order breaks count ties, so equal counts stay in it.
    /// Sorted on the threads the gate has free (that order is total, so it is the one a single sort gives).</summary>
    private static int[] ByCount(int[] counts)
    {
        var ranked = new int[counts.Length];
        for (var i = 0; i < ranked.Length; i++) ranked[i] = i;
        Sort(ranked, 0, ranked.Length, new CountOrder(counts));
        return ranked;
    }

    private sealed class CountOrder(int[] counts) : IComparer<int>
    {
        public int Compare(int a, int b) => counts[a] != counts[b] ? counts[b].CompareTo(counts[a]) : a.CompareTo(b);
    }

    /// <summary>The runs of equal values in sorted rows, in value order: each run's first row (the lowest holding it, since
    /// ties fall back to the base row), its length, and whether a kept row is among it. The rows are read in even runs on the
    /// threads the gate has free, each run reading only its own rows: first each marks where a value starts (comparing a row
    /// with the one before it, so a value that spans runs starts in one only); then, with the values each run starts
    /// numbered, each notes where its values start and ticks the value each of its rows is in (a value its run continues from
    /// the run before is the one numbered just before its first); a value's length is where the next starts less its own
    /// start. So a value on most of the rows is read by every thread, not one.</summary>
    private static (int[] Reps, int[] Counts, bool[] Ticks) Runs(Key key, int[] values, int count, bool[]? marks, CancellationToken token)
    {
        var starts = new bool[count];
        var wanted = Math.Clamp(count / MinSlice, 1, Workers);
        using var threads = Gate.Take(wanted);
        var runs = wanted;
        var found = new int[runs + 1];
        threads.For(runs, run =>
        {
            var at = 0;
            for (int i = RunStart(count, run, runs), end = RunStart(count, run + 1, runs); i < end; i++)
            {
                // Comparing long texts under a collation is slow.
                if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                if (i == 0 || key.Compare(values[i - 1], values[i]) != 0) { starts[i] = true; at++; }
            }
            found[run + 1] = at;
        }, token);
        for (var run = 0; run < runs; run++) found[run + 1] += found[run];
        var groups = found[runs];
        var reps = new int[groups];
        // Each value's first row's place first, its length once every place is known.
        var counts = new int[groups];
        var ticks = new bool[groups];
        threads.For(runs, run =>
        {
            var group = found[run] - 1;
            for (int i = RunStart(count, run, runs), end = RunStart(count, run + 1, runs); i < end; i++)
            {
                if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                if (starts[i])
                {
                    group++;
                    reps[group] = values[i];
                    counts[group] = i;
                }
                // Two runs may tick the value one continues from the other: both write true.
                if (marks is null || marks[values[i]]) ticks[group] = true;
            }
        }, token);
        for (var group = 0; group < groups; group++) counts[group] = (group + 1 < groups ? counts[group + 1] : count) - counts[group];
        return (reps, counts, ticks);
    }

    /// <summary>The rows' values by a key whose codes are its values, counted in one pass without sorting the rows: each
    /// value's lowest row, its count and its tick, in value order. Null past <see cref="MaxGroups"/> values, which a sort
    /// then groups.</summary>
    private static (int[] Reps, int[] Counts, bool[] Ticks)? Grouped(Key key, int[] rows, int count, bool[]? marks, CancellationToken token)
    {
        var groups = new Dictionary<ulong, int>();
        var reps = new List<int>();
        var counts = new List<int>();
        var ticks = new List<bool>();
        for (var i = 0; i < count; i++)
        {
            if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            var row = rows[i];
            ref var slot = ref System.Runtime.InteropServices.CollectionsMarshal.GetValueRefOrAddDefault(groups, key.Code(row), out var known);
            if (!known)
            {
                if (reps.Count >= MaxGroups) return null;
                slot = reps.Count;
                reps.Add(row);
                counts.Add(0);
                ticks.Add(marks is null);
            }
            var group = slot;
            counts[group]++;
            if (row < reps[group]) reps[group] = row;
            if (marks is not null && marks[row]) ticks[group] = true;
        }
        var order = new int[reps.Count];
        for (var i = 0; i < order.Length; i++) order[i] = i;
        Array.Sort(order, (a, b) => key.Compare(reps[a], reps[b]));
        return ([.. order.Select(group => reps[group])], [.. order.Select(group => counts[group])], [.. order.Select(group => ticks[group])]);
    }

    /// <summary>A cell's grid text, cut to <see cref="DistinctValueChars"/> characters with "…": binary as 0x and hex, and
    /// a truncated stored value marked too.</summary>
    internal static string Display(PageSource source, int row, int column, WireKind wire)
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
