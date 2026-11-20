using System.Buffers.Binary;
using System.Security.Cryptography;
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
    private readonly KeptPages source;
    private readonly int[] reps, counts, byCount;
    private readonly bool[] ticks;
    private int ticked;
    private bool nullTicked;
    private (FilterOp Op, int[] Rows, bool Nulls)? frozen;
    private string? digest;
    // Marks: each group's 1 when it matched, 2 when it did not but a narrowed search must look at it again.
    private (string Text, int[] ByValue, int[] ByCount, byte[] Marks, SearchNarrowing.Kind Kind, SearchNarrowing.Needs Needs, string? Fold)? lastSearch;
    // The groups by their representative row, made by the first search while the result is packed (under the search lock),
    // so a search reads each packed page once.
    private int[]? byRow;

    internal DistinctSnapshot(ResultSetBuffer set, int column, KeptPages source, int[] reps, int[] counts, int[] byCount, bool[] ticks, long rows, long nulls, bool nullTicked, bool complete, bool approximate)
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
        var texts = new string[take];
        int GroupAt(int i) => list?[offset + i] ?? offset + i;
        // The display texts read the pages, which only the search lock's holders also read.
        lock (searching)
            source.Each(take, i => reps[GroupAt(i)], (i, view, local) => texts[i] = ViewSorter.Display(view, local, Column, wire), token);
        for (var i = 0; i < take; i++)
        {
            var group = GroupAt(i);
            values[i] = new DistinctValue(group, reps[group], texts[i], counts[group], false);
        }
        lock (gate)
        {
            for (var i = 0; i < take; i++) values[i] = values[i] with { Checked = ticks[values[i].Group] };
            return (total, values, ticked, nullTicked);
        }
    }

    /// <summary>Ticks or clears the groups named, or every value (those matching <paramref name="search"/> with one), or the
    /// values at <paramref name="ranges"/> (offset and count) of the list in <paramref name="order"/>, searched with a search,
    /// and NULL when <paramref name="nulls"/> says. <paramref name="toggle"/> (with ranges) ticks them all when any of them, or
    /// NULL when <paramref name="nulls"/> is given, is cleared, else clears them all, NULL alike; <paramref name="invert"/>
    /// flips every value. INVALID_PARAMS for a group or a range it does not have, or once a filter froze it.</summary>
    public (int Checked, bool NullChecked) Tick(bool check, int[]? groups, bool all, string? search, bool? nulls, CancellationToken token,
        DistinctOrder order = DistinctOrder.Value, long[][]? ranges = null, bool toggle = false, bool invert = false)
    {
        if (groups is not null && groups.Any(group => group < 0 || group >= reps.Length))
            throw new RequestException("INVALID_PARAMS", "A value to tick is not one of the list's.");
        // A search's matches are found before the ticks' lock is taken.
        var matched = all && search is not null ? Matches(search, token).ByValue : null;
        int[]? listed = null;
        var total = reps.Length;
        if (ranges is not null)
        {
            listed = search is null ? (order == DistinctOrder.Count ? byCount : null) : order == DistinctOrder.Count ? Matches(search, token).ByCount : Matches(search, token).ByValue;
            total = listed?.Length ?? reps.Length;
            if (ranges.Any(range => range[0] + range[1] > total))
                throw new RequestException("INVALID_PARAMS", "A range of values to tick is past the list's end.");
        }
        int GroupAt(long at) => listed?[at] ?? (int)at;
        lock (gate)
        {
            if (frozen is not null) throw new RequestException("INVALID_PARAMS", "These values already filter the grid. Open the column's filter again to change them.");
            if (invert)
            {
                for (var group = 0; group < ticks.Length; group++) ticks[group] = !ticks[group];
                ticked = reps.Length - ticked;
            }
            else if (ranges is not null)
            {
                if (toggle)
                {
                    check = nulls is not null && !nullTicked;
                    for (var r = 0; r < ranges.Length && !check; r++)
                        for (long at = ranges[r][0], end = ranges[r][0] + ranges[r][1]; at < end; at++)
                            if (!ticks[GroupAt(at)]) { check = true; break; }
                    if (nulls is not null) nulls = check;
                }
                foreach (var range in ranges)
                {
                    for (long at = range[0], end = range[0] + range[1]; at < end; at++)
                    {
                        var group = GroupAt(at);
                        if (ticks[group] == check) continue;
                        ticks[group] = check;
                        ticked += check ? 1 : -1;
                    }
                }
            }
            else if (all && search is null)
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

    /// <summary>What the filter its ticks make keeps (<see cref="Freeze"/>, which it calls), in 32 hex digits: the first half of
    /// a SHA-256 of the column, whether it keeps or drops, NULL and its rows in value order, each the lowest of the rows grouped
    /// holding its value. Two snapshots over the same rows that tick the same values have the same digest, so a Pivot's
    /// recorded filters compare by it rather than by snapshot id; the rows themselves, one a distinct value, are too many to
    /// send. Hashed once, in 1 KiB chunks outside the ticks' lock, and kept: the frozen filter never changes, and two callers
    /// racing compute the same text.</summary>
    public string Digest()
    {
        if (Volatile.Read(ref digest) is { } done) return done;
        var (op, rows, nulls) = Freeze();
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> chunk = stackalloc byte[1024];
        BinaryPrimitives.WriteInt32LittleEndian(chunk, Column);
        chunk[4] = op == FilterOp.In ? (byte)1 : (byte)0;
        chunk[5] = nulls ? (byte)1 : (byte)0;
        hash.AppendData(chunk[..6]);
        for (var at = 0; at < rows.Length; at += chunk.Length / 4)
        {
            var count = Math.Min(chunk.Length / 4, rows.Length - at);
            for (var i = 0; i < count; i++) BinaryPrimitives.WriteInt32LittleEndian(chunk[(4 * i)..], rows[at + i]);
            hash.AppendData(chunk[..(4 * count)]);
        }
        Span<byte> sum = stackalloc byte[32];
        hash.GetHashAndReset(sum);
        var text = Convert.ToHexStringLower(sum[..16]);
        Volatile.Write(ref digest, text);
        return text;
    }

    /// <summary>The groups whose display text contains the search, in value order and in count order, kept until another
    /// search; found under the search lock, never the ticks'. A search whose text extends the last one's
    /// (<see cref="SearchNarrowing.Extends"/>, as the user types) reads only the groups the last one matched or marked to
    /// look at again; <see cref="LastNarrowed"/> says whether it did.</summary>
    private (int[] ByValue, int[] ByCount) Matches(string search, CancellationToken token)
    {
        lock (searching)
        {
            if (lastSearch is { } last && last.Text == search) return (last.ByValue, last.ByCount);
            var matcher = ResultSearcher.MatcherFor(Set.Columns[Column], Set.Wires[Column], search);
            var kind = matcher?.Kind ?? SearchNarrowing.Kind.None;
            var fold = (matcher as ResultSearcher.CultureMatcher)?.Folded;
            var scratch = new ResultSearcher.Scratch();
            var marks = new byte[reps.Length];
            var found = 0;
            LastNarrowed = false;
            var needs = SearchNarrowing.Needs.None;
            if (matcher is not null)
            {
                void Visit(int group, PageView view, int local)
                {
                    if (matcher.Matches(view.Span(Column, local), scratch, out var recheck)) { marks[group] = 1; found++; }
                    else if (recheck) marks[group] = 2;
                }
                if (lastSearch is { } previous && SearchNarrowing.Extends(previous.Text, [previous.Kind], [previous.Needs], [previous.Fold], search, [kind], [fold]))
                {
                    if (matcher is ResultSearcher.CultureMatcher culture) culture.KeepPrechecking = true;
                    needs = previous.Needs;
                    var count = 0;
                    foreach (var mark in previous.Marks) if (mark != 0) count++;
                    var candidates = new int[count];
                    for (int group = 0, at = 0; group < previous.Marks.Length; group++) if (previous.Marks[group] != 0) candidates[at++] = group;
                    source.Each(count, item => reps[candidates[item]], (item, view, local) => Visit(candidates[item], view, local), token);
                    LastNarrowed = true;
                }
                else source.Each(reps.Length, group => reps[group], Visit, token, () => byRow ??= KeptPages.ByRow(reps));
                needs |= matcher.Needs;
            }
            var byValue = new int[found];
            var ranked = new int[found];
            for (int group = 0, at = 0; group < reps.Length; group++) if (marks[group] == 1) byValue[at++] = group;
            for (int i = 0, at = 0; i < byCount.Length; i++) if (marks[byCount[i]] == 1) ranked[at++] = byCount[i];
            lastSearch = (search, byValue, ranked, marks, kind, needs, fold);
            return (byValue, ranked);
        }
    }

    /// <summary>Whether the last search that read values narrowed from the one before it (the checks).</summary>
    internal bool LastNarrowed { get; private set; }

    /// <summary>The rules the last search's ruled-out values need of a later text (checks only).</summary>
    internal SearchNarrowing.Needs LastNeeds { get { lock (searching) return lastSearch?.Needs ?? SearchNarrowing.Needs.None; } }

    /// <summary>Forgets the last search, so the next reads every value (the checks' reference).</summary>
    internal void ForgetSearch()
    {
        lock (searching) lastSearch = null;
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
    /// (4 bytes each a group), its ticks (1), a search's matches in both orders and their marks (9), a frozen filter's
    /// rows (4), and, once a search reads a packed result, the groups in row order (4): 30 bytes a group, and its
    /// bookkeeping.</summary>
    public static long DistinctSnapshotBytes(long groups) => 30L * groups + 4096;

    /// <summary>What a distinct list answers (TOO_LARGE) when the budget has no room for its working memory, or for the rooms
    /// or a column extract a packed result is read through.</summary>
    public const string DistinctTooLarge = "There is not enough result memory to list this column's values. Close other results and try again.";

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
        using var pin = set.Pin();
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
        // A packed result is read fused, as a sort reads it (its rooms and any column extract held only while this runs);
        // the snapshot reads its values' pages again through the set when asked (KeptPages), keeping none of them.
        using var source = new PageSource(pages, set.Wires.Count, DistinctTooLarge);
        var keptPages = new KeptPages(set, pages, set.Wires.Count);
        var approximate = false;
        var progress = OperationProgress.Current;
        progress?.Phase("keys", 0.5);
        var key = Build(set, source, new ViewKey(column, false, SortMode.Value), null, rows, token, ref approximate, memory);
        if (stages is not null) stages.Key += Lap();
        progress?.Phase("group", 0.98);
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
            return new DistinctSnapshot(set, column, keptPages, grouped.Reps, grouped.Counts, codedRanks, grouped.Ticks, looked, nulls, nullTicked, complete, approximate);
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
        return new DistinctSnapshot(set, column, keptPages, reps, counts, ranks, ticks, looked, nulls, nullTicked, complete, approximate);
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
    internal static string Display(PageView view, int local, int column, WireKind wire)
    {
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

/// <summary>The pages a distinct snapshot reads its values from after it is built (results.distinctRead's texts, a search's
/// matches): the result's own pages, read through the set each time and never kept, so a result packed after the snapshot
/// was built holds only its packed bytes. Each read pins the set. While no page is packed, rows are read in the order asked,
/// in place, each page's header parsed once; otherwise in row order, each packed page unpacked once into one room
/// (<see cref="ReadRoom"/>, reserved as working memory while the read runs, and read through the set's cache when there is
/// no room, so a read is never refused). Read by one thread at a time (the snapshot's search lock).</summary>
internal sealed class KeptPages
{
    private readonly ResultSetBuffer set;
    private readonly StoredPage[] pages;
    private readonly long[] starts;
    private readonly int columns;
    private readonly int[]?[] layouts;
    private readonly int[] blobStarts;

    internal delegate void Visit(int item, PageView view, int local);

    public KeptPages(ResultSetBuffer set, StoredPage[] pages, int columns)
    {
        this.set = set;
        this.pages = pages;
        this.columns = columns;
        starts = new long[pages.Length];
        for (var i = 0; i < pages.Length; i++) starts[i] = pages[i].FirstRow;
        layouts = new int[pages.Length][];
        blobStarts = new int[pages.Length];
    }

    /// <summary>The items in the order of their rows (ties by item), for <see cref="Each"/>'s order.</summary>
    public static int[] ByRow(int[] rows)
    {
        var order = new int[rows.Length];
        for (var i = 0; i < order.Length; i++) order[i] = i;
        Array.Sort(order, (a, b) => rows[a] != rows[b] ? rows[a].CompareTo(rows[b]) : a.CompareTo(b));
        return order;
    }

    private int IndexOf(int row)
    {
        var index = Array.BinarySearch(starts, (long)row);
        return index < 0 ? ~index - 1 : index;
    }

    /// <summary>Reads item 0 to <paramref name="count"/> - 1's rows (<paramref name="rowOf"/>), each with its page. With a
    /// packed page among them they go in row order: <paramref name="order"/>'s when given (the items sorted by row), else
    /// sorted here.</summary>
    public void Each(int count, Func<int, int> rowOf, Visit visit, CancellationToken token, Func<int[]>? order = null)
    {
        using var pin = set.Pin();
        if (!set.HasPacked)
        {
            for (var item = 0; item < count; item++)
            {
                if ((item & (ViewSorter.CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var row = rowOf(item);
                var index = IndexOf(row);
                var page = pages[index];
                // Nothing packs a pinned set, so its pages stay as sealed while it is read.
                var body = set.Raw(page) ?? page.Body();
                if (layouts[index] is not { } layout)
                {
                    var parsed = PageView.Parse(body, columns);
                    layouts[index] = layout = parsed.Layout;
                    blobStarts[index] = parsed.BlobStart;
                }
                visit(item, PageView.At(body, blobStarts[index], layout, page.FirstRow, page.Rows, columns), (int)(row - page.FirstRow));
            }
            return;
        }
        int[] items;
        if (order is not null) items = order();
        else
        {
            var rows = new int[count];
            for (var item = 0; item < count; item++) rows[item] = rowOf(item);
            items = ByRow(rows);
        }
        using var room = new ReadRoom(set);
        var scratch = new int[PageView.ScratchLength(columns)];
        var current = -1;
        var blobStart = 0;
        ReadOnlySpan<byte> bytes = default;
        for (var at = 0; at < items.Length; at++)
        {
            if ((at & (ViewSorter.CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            var item = items[at];
            var row = rowOf(item);
            var index = IndexOf(row);
            var page = pages[index];
            if (index != current)
            {
                bytes = room.Body(page);
                blobStart = PageView.Parse(bytes, columns, scratch).BlobStart;
                current = index;
            }
            visit(item, PageView.At(bytes, blobStart, scratch, page.FirstRow, page.Rows, columns), (int)(row - page.FirstRow));
        }
    }
}
