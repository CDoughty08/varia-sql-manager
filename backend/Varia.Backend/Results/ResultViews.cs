using System.Buffers.Binary;
using System.Globalization;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>How a sort key compares a column: its values (by SQL type and collation), or, for text and binary columns, each
/// cell's characters or bytes (DATALENGTH; CellLengths.cs).</summary>
internal enum SortMode { Value, Chars, Bytes }

internal sealed record ViewKey(int Column, bool Descending, SortMode Mode);

/// <summary>How a view filter keeps rows: a column's value among some values (In) or not (NotIn), between two values,
/// rows whose values in some columns repeat (Duplicates), or the rows it names themselves (KeepRows), which compares no
/// column.</summary>
internal enum FilterOp { In, NotIn, Between, Duplicates, KeepRows }

/// <summary>Cells a filter takes its values from: positions in a view's order (or the result's own when Order is null).</summary>
internal sealed record ViewCells(int[]? Order, (long First, long Count)[] Ranges);

/// <summary>One results.view filter. In, NotIn and Between compare Column's values with those of base rows (Rows: one row per
/// distinct value; Between's lowest and highest), or of the cells a selection named (Cells), which building the view
/// resolves to rows; Nulls says NULL is among In's and NotIn's values. Duplicates compares Columns. Equality and order are
/// the sort's (<see cref="ViewSorter"/>): a column's collation decides which texts are equal.
/// A distinct snapshot's checklist (<see cref="Snapshot"/>) arrives already resolved: In or NotIn with its values' rows in
/// value order, one a value, however many. KeepRows keeps exactly the base rows it names (Rows, ascending once resolved),
/// or those at the positions a selection named (Cells): at most <see cref="ViewSorter.MaxKeepRows"/>, and no column.</summary>
internal sealed record ViewFilter(FilterOp Op, int Column, int[]? Rows, bool Nulls, ViewCells? Cells, int[] Columns, uint? Snapshot = null);

/// <summary>A view of one stored result: its rows in another order (and, later, only some of them), as base row numbers.
/// Reads through it build pages in view order from the stored ones (<see cref="ViewPages"/>), so the renderer caches and
/// draws them as it does a result's own. It covers the rows sealed when it was built; a view of a set still loading is
/// built again by the renderer once more rows arrive. Its order array is charged to the result's query budget and
/// returned when the view is closed, replaced, or its result is released.</summary>
internal sealed class ResultView(uint viewId, ResultSetBuffer set, int[] order, IReadOnlyList<ViewKey> keys, bool approximate, bool complete, long charged, long baseRows = long.MaxValue)
{
    public uint ViewId { get; } = viewId;
    public ResultSetBuffer Set { get; } = set;
    /// <summary>The base row shown at each view position.</summary>
    public int[] Order { get; } = order;
    public IReadOnlyList<ViewKey> Keys { get; } = keys;
    /// <summary>A key compared a truncated value's stored prefix, or a length that is only an estimate.</summary>
    public bool Approximate { get; } = approximate;
    /// <summary>The result had finished loading when the view was built: it covers every row.</summary>
    public bool Complete { get; } = complete;
    /// <summary>The base rows it was built from (those sealed then): a row past them is one it has not looked at.</summary>
    public long BaseRows { get; } = baseRows;
    internal long Charged { get; } = charged;
    public long Rows => Order.Length;
}

/// <summary>Builds a view's order: a stable sort of the result's sealed rows by up to <see cref="MaxKeys"/> keys, as SQL
/// Server's ORDER BY would put them. NULL (and a cell that could not be read) sorts lowest: first ascending, last
/// descending. Exact numerics compare as numbers at any precision; real and float as doubles; uniqueidentifier in SQL
/// Server's byte order; datetimeoffset by its UTC instant; the other date and time types by their fixed-width display text;
/// binary values byte by byte; character columns by their collation (its locale and Ignore flags, or code-point order for
/// _BIN and _BIN2), ignoring trailing spaces as SQL Server does; every other type by its display text's code points.
/// Each row keeps 8 to 16 bytes per key while sorting (a number, or a prefix of its collation sort key), so most
/// comparisons never touch the stored cell. A collated column of repeated values keeps each row's rank among them instead,
/// and any other keeps its rows' whole sort keys as well (less the bytes they all start with) while the budget has room
/// for them (<see cref="KeyMemory"/>), so its ties compare bytes; without them, and for the other kinds, a tie reads the
/// cells again from their pages. Keys are built and rows sorted on several threads (<see cref="Workers"/>).</summary>
internal static partial class ViewSorter
{
    public const int MaxKeys = 16;
    /// <summary>Filters one view takes, distinct values one In or NotIn filter holds, and cell ranges one selection names
    /// (src/shared/ipc/wire/protocol.ts limits.views).</summary>
    public const int MaxFilters = 16, MaxFilterValues = 4096, MaxFilterRanges = 256;
    /// <summary>Rows one KeepRows filter names: those a transposed grid draws as columns (limits.transpose.maxRows).</summary>
    public const int MaxKeepRows = ResultTextWriter.MaxTransposedRows;
    /// <summary>Bytes a row one filter holds at most while it runs, besides its column's key: Duplicates' positions (4), group
    /// starts (up to 8, as their list grows) and the rows it keeps (4); Keep and Pick hold less.</summary>
    public const int FilterBytes = 16;
    internal const int CancelEvery = 1 << 14;

    /// <summary>Bytes a sort holds per row and key while it runs: the key's 8- or 16-byte value and two bits (NULL, and a
    /// collated key's rows that start unlike the rest), and per row the positions sorted and the buffer their slices merge through. A collated key's whole sort keys come on top,
    /// reserved as they are built (<see cref="KeyMemory"/>).</summary>
    public static long WorkingBytes(long rows, int keys) => rows * (16L * keys + 8) + (rows / 4 + 8) * keys;

    /// <summary>Threads the results' operations use between them: most of the machine's, leaving some for the queries
    /// still reading and for the requests the thread pool answers.</summary>
    internal static int Workers
    {
        get => scopedWorkers.Value > 0 ? scopedWorkers.Value : workers;
        set => workers = value;
    }
    private static int workers = Math.Clamp(Environment.ProcessorCount * 3 / 4, 1, 16);
    private static readonly AsyncLocal<int> scopedWorkers = new();

    /// <summary><see cref="Workers"/> for the calling flow alone (and the threads it starts) until disposed: checks that
    /// compare a count of threads with another, while other checks run beside them, set it here rather than for them all.</summary>
    internal static IDisposable WorkersHere(int count) => new ScopedWorkers(count);

    private sealed class ScopedWorkers : IDisposable
    {
        private readonly int before = scopedWorkers.Value;
        public ScopedWorkers(int count) => scopedWorkers.Value = count;
        public void Dispose() => scopedWorkers.Value = before;
    }
    /// <summary>The fewest rows a slice of a parallel sort holds; fewer rows than two of these sort on one thread.</summary>
    internal const int MinSlice = 1 << 15;
    /// <summary>Rows sampled to learn how a column's values repeat.</summary>
    internal const int Sampled = 4096;
    /// <summary>Comparisons that read their cells again from the pages, counted as one thread would make them one after
    /// another, past which a sort is refused rather than left to run until its request's deadline: a text, date or binary
    /// column whose rows mostly share the 8 bytes kept of each, when the budget had no room for more. About 0.4
    /// microseconds each, so about a minute; the requests that sort have two.</summary>
    internal const long MaxSlowCompares = 150_000_000;
    /// <summary>The most values rows are grouped by without sorting them (<see cref="Key.Coded"/>); more are sorted.</summary>
    internal const int MaxGroups = 1 << 16;
    internal const string TooSlow = "There is not enough result memory to compare this much text. Close other results and try again.";

    internal static readonly WorkerGate Gate = new(() => Workers);

    /// <summary>The budget a build's keys take what they hold beyond their rows' fixed bytes from, and give it back to.</summary>
    /// <param name="reserve">Takes bytes; its second argument says this request takes the keys past another
    /// <see cref="CheckEvery"/> held, where the taker may ask what it would of one request that large (the system's
    /// memory load): the keys come a page, or a value, at a time.</param>
    internal sealed class KeyMemory(Func<long, bool, bool> reserve, Action<long> release)
    {
        internal const long CheckEvery = ResultStore.WorkCheckBytes;
        private long held;

        public KeyMemory(Func<long, bool> reserve, Action<long> release) : this((bytes, _) => reserve(bytes), release) { }

        public bool TryReserve(long bytes)
        {
            // Counted first, so of threads taking together exactly one sees each 64 MiB passed.
            var after = Interlocked.Add(ref held, bytes);
            if (reserve(bytes, after / CheckEvery != (after - bytes) / CheckEvery)) return true;
            Interlocked.Add(ref held, -bytes);
            return false;
        }
        public void Return(long bytes)
        {
            if (bytes <= 0) return;
            Interlocked.Add(ref held, -bytes);
            release(bytes);
        }
        /// <summary>What the keys still hold: they are done with once their build's order is.</summary>
        public void ReturnAll() => Return(Interlocked.Read(ref held));
    }

    private static int Slices(int count, int threads)
    {
        var slices = 1;
        while (slices * 2 <= threads && count / (slices * 2) >= MinSlice) slices *= 2;
        return slices;
    }

    /// <summary>Sorts <paramref name="count"/> items from <paramref name="start"/>: slices on the threads the gate has
    /// free, merged pairwise. The comparer orders any two items (ties by index), so the result is the one a single sort
    /// gives, and it is called from several threads at once.</summary>
    internal static void Sort(int[] items, int start, int count, IComparer<int> comparer)
    {
        if (count < 2 * MinSlice)
        {
            if (count > 1) SortRange(items, start, count, comparer);
            return;
        }
        using var threads = Gate.Take(Math.Min(Workers, count / MinSlice));
        // Up to four slices a thread: a sort holding more than its share hands threads back between slices too, and one
        // given fewer threads than it asked for still spreads its slices evenly over them. The two extra rounds of merges
        // cost about the comparisons the smaller slices save.
        var slices = Slices(count, threads.Wanted == 1 ? 1 : 4 * threads.Wanted);
        if (slices == 1)
        {
            SortRange(items, start, count, comparer);
            return;
        }
        int At(int slice, int of) => start + (int)((long)count * slice / of);
        // Each slice and each merge is an item. The comparer throws a cancellation, which For rethrows once the other threads
        // have stopped.
        threads.For(slices, slice => SortRange(items, At(slice, slices), At(slice + 1, slices) - At(slice, slices), comparer));
        // The merges go through a buffer of the items sorted, not of the whole array: a caller sorting many ranges of one
        // array (a pivot's cells) holds one range's buffer at a time. Positions are from start; the buffer's are from 0.
        int[] from = items, to = new int[count];
        int fromAt = start, toAt = 0;
        for (var width = slices; width > 1; width /= 2)
        {
            var (source, target, of, sourceAt, targetAt) = (from, to, width, fromAt - start, toAt - start);
            threads.For(width / 2, pair =>
            {
                int left = At(2 * pair, of), middle = At(2 * pair + 1, of), end = At(2 * pair + 2, of);
                int a = left, b = middle, at = left;
                while (a < middle && b < end) target[targetAt + at++] = comparer.Compare(source[sourceAt + b], source[sourceAt + a]) < 0 ? source[sourceAt + b++] : source[sourceAt + a++];
                while (a < middle) target[targetAt + at++] = source[sourceAt + a++];
                while (b < end) target[targetAt + at++] = source[sourceAt + b++];
            });
            (from, to, fromAt, toAt) = (to, from, toAt, fromAt);
        }
        if (from != items) Array.Copy(from, 0, items, start, count);
    }

    /// <summary>Array.Sort over a range, a cancellation its comparer throws rethrown as itself: Array.Sort wraps whatever a
    /// comparer throws in an InvalidOperationException.</summary>
    internal static void SortRange(int[] items, int start, int count, IComparer<int> comparer)
    {
        try { Array.Sort(items, start, count, comparer); }
        catch (InvalidOperationException error) when (error.InnerException is OperationCanceledException cancelled)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(cancelled).Throw();
        }
    }

    /// <summary>The start of run <paramref name="run"/> of <paramref name="runs"/> even runs over <paramref name="count"/> items.</summary>
    internal static int RunStart(int count, int run, int runs) => (int)((long)count * run / runs);

    /// <summary>A sort's comparisons as the time one thread would take to make that many one after another: the slices
    /// are sorted side by side, but each round of merges runs on half the threads of the one before, the last on one.</summary>
    internal static double SortCost(int count)
    {
        var slices = Slices(count, Workers);
        var cost = count * Math.Log2(Math.Max(2.0, (double)count / slices)) / slices;
        for (var width = slices; width > 1; width /= 2) cost += (double)count / (width / 2);
        return cost;
    }

    /// <summary>About how many distinct values <paramref name="rows"/> rows hold, from a sample of <paramref name="taken"/>
    /// that held <paramref name="distinct"/>: about that many when the sample repeats itself often; otherwise by how
    /// rarely it does (two of a sample share a value about once in twice the number of values).</summary>
    internal static double Distinct(int distinct, int taken, long rows)
    {
        if (taken == 0) return 0;
        if (distinct * 10L < taken * 9L) return distinct;
        return Math.Min(rows, (double)taken * taken / (2.0 * Math.Max(1, taken - distinct)));
    }

    /// <summary>Up to <paramref name="samples"/> places among <paramref name="count"/>, ascending, each once: all of them
    /// when there are no more, otherwise scattered as if at random (the same ones every time). Evenly spaced places would
    /// read one row of each run of equal values in rows sorted by a column, and one of each value where values repeat at
    /// a period, and find a column of repeated values to hold none.</summary>
    internal static int[] Places(int count, int samples)
    {
        if (count <= samples)
        {
            var all = new int[Math.Max(0, count)];
            for (var i = 0; i < all.Length; i++) all[i] = i;
            return all;
        }
        var places = new int[samples];
        var state = 0x9E3779B97F4A7C15UL;
        for (var i = 0; i < samples; i++)
        {
            // SplitMix64.
            var z = state += 0x9E3779B97F4A7C15UL;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            places[i] = (int)((z ^ (z >> 31)) % (ulong)count);
        }
        Array.Sort(places);
        var kept = 0;
        for (var i = 0; i < samples; i++)
            if (i == 0 || places[i] != places[i - 1]) places[kept++] = places[i];
        Array.Resize(ref places, kept);
        return places;
    }

    /// <summary>About how many of the rows hold each value of a key (NULL as a value), from a sample of them.</summary>
    internal static double GroupSize(Key key, ReadOnlySpan<int> rows)
    {
        var sample = Places(rows.Length, Sampled);
        var taken = sample.Length;
        if (taken == 0) return 1;
        for (var i = 0; i < taken; i++) sample[i] = rows[sample[i]];
        int Compare(int a, int b)
        {
            bool nullA = key.IsNull(a), nullB = key.IsNull(b);
            return nullA || nullB ? nullB.CompareTo(nullA) : key.Compare(a, b);
        }
        Array.Sort(sample, Compare);
        var distinct = 1;
        for (var i = 1; i < taken; i++) if (Compare(sample[i - 1], sample[i]) != 0) distinct++;
        return rows.Length / Math.Max(1, Distinct(distinct, taken, rows.Length));
    }

    /// <summary>Refuses a sort of these rows that would spend its request's time reading cells again from their pages. The
    /// first key is compared by every comparison; a later key only by those between rows the keys before it hold equal,
    /// which are few when those keys' values seldom repeat (none, after a key that is each row's own).</summary>
    internal static void ThrowIfSlow(ReadOnlySpan<Key> keys, ReadOnlySpan<int> rows)
    {
        if (rows.Length < MinSlice) return;
        var slow = false;
        foreach (var key in keys) slow |= key.TieShare > 0;
        if (!slow) return;
        double reaching = 1, reading = 0;
        for (var k = 0; k < keys.Length && reaching > 0; k++)
        {
            reading += reaching * keys[k].TieShare;
            if (k + 1 < keys.Length) reaching *= Math.Min(1, Math.Log2(Math.Max(1, GroupSize(keys[k], rows))) / Math.Log2(rows.Length));
        }
        if (reading * SortCost(rows.Length) > MaxSlowCompares) throw new RequestException("TOO_LARGE", TooSlow);
    }

    /// <summary>A collation's sort key of a text, in <paramref name="buffer"/> (grown when the key is longer): asked for
    /// once, where asking for its length first computes it twice.</summary>
    internal static int SortKey(CompareInfo info, CompareOptions options, ReadOnlySpan<char> text, ref byte[] buffer, Action<int>? growing = null)
    {
        try { return info.GetSortKey(text, buffer, options); }
        catch (ArgumentException)
        {
            var size = info.GetSortKeyLength(text, options);
            if (size <= buffer.Length) throw;
            var grown = Math.Max(size, 2 * buffer.Length);
            growing?.Invoke(grown - buffer.Length);
            buffer = new byte[grown];
            return info.GetSortKey(text, buffer, options);
        }
    }

    public static (int[] Order, bool Approximate) Sort(ResultSetBuffer set, StoredPage[] pages, IReadOnlyList<ViewKey> keys, CancellationToken token)
    {
        var built = Build(set, pages, keys, [], token);
        return (built.Order, built.Approximate);
    }

    /// <summary>Keys a view holds while it is built: one per column its filters compare and one per sort key, except that a
    /// Value sort key on a filtered column is that filter's key. KeepRows compares no column, so it has no key.</summary>
    public static int KeyCount(IReadOnlyList<ViewKey> keys, IReadOnlyList<ViewFilter> filters)
    {
        var columns = new HashSet<int>();
        foreach (var filter in filters)
        {
            if (filter.Op == FilterOp.Duplicates) columns.UnionWith(filter.Columns);
            else if (filter.Op != FilterOp.KeepRows) columns.Add(filter.Column);
        }
        var count = columns.Count;
        foreach (var key in keys)
            if (key.Mode != SortMode.Value || !columns.Contains(key.Column)) count++;
        return count;
    }

    /// <summary>A view's order: the sealed rows its filters keep, in turn (each over the rows the ones before it kept), then
    /// sorted by its keys. Without keys, rows keep the result's order, except that Duplicates puts each group of equal rows
    /// together, in the order of their first rows. Returns the filters with their cells resolved to rows.</summary>
    public static (int[] Order, bool Approximate, ViewFilter[] Filters) Build(ResultSetBuffer set, StoredPage[] pages, IReadOnlyList<ViewKey> keys, IReadOnlyList<ViewFilter> filters, CancellationToken token, KeyMemory? memory = null)
    {
        try { return Build(set, pages, keys, filters, memory, token); }
        finally { memory?.ReturnAll(); }
    }

    private static (int[] Order, bool Approximate, ViewFilter[] Filters) Build(ResultSetBuffer set, StoredPage[] pages, IReadOnlyList<ViewKey> keys, IReadOnlyList<ViewFilter> filters, KeyMemory? memory, CancellationToken token)
    {
        long total = 0;
        foreach (var page in pages) total += page.Rows;
        if (total > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to sort.");
        var rows = (int)total;
        var source = new PageSource(pages, set.Wires.Count);
        var approximate = false;
        var values = new Dictionary<int, Key>();
        Key ValueKey(int column)
        {
            if (!values.TryGetValue(column, out var key))
                values[column] = key = Build(set, source, new ViewKey(column, false, SortMode.Value), null, rows, token, ref approximate, memory);
            return key;
        }
        var order = new int[rows];
        for (var i = 0; i < rows; i++) order[i] = i;
        var resolved = new ViewFilter[filters.Count];
        for (var f = 0; f < filters.Count; f++)
        {
            var filter = filters[f];
            if (filter.Op == FilterOp.Duplicates)
            {
                var columns = new Key[filter.Columns.Length];
                for (var c = 0; c < columns.Length; c++) columns[c] = ValueKey(filter.Columns[c]);
                order = Duplicates(order, columns, token);
                resolved[f] = filter;
                continue;
            }
            if (filter.Op == FilterOp.KeepRows)
            {
                var named = filter.Cells is { } selected ? Selected(selected, rows, token) : Named(filter.Rows!, rows);
                // The first filter sees every row in base order: the rows it names are the rows it keeps, without a pass over
                // the result's.
                order = f == 0 ? (int[])named.Clone() : KeepRows(order, named, token);
                resolved[f] = filter with { Rows = named, Cells = null };
                continue;
            }
            var key = ValueKey(filter.Column);
            if (filter.Snapshot is not null)
            {
                // A checklist's rows are its snapshot's: already one a value, in this key's order, and below the rows sealed.
                order = Keep(order, key, filter.Op, filter.Rows!, filter.Nulls, token);
                resolved[f] = filter;
                continue;
            }
            var (reps, nulls) = filter.Cells is { } cells ? Pick(key, cells, rows, token) : Distinct(key, filter.Rows!, rows, token);
            nulls |= filter.Nulls;
            if (filter.Op == FilterOp.Between)
            {
                if (filter.Rows is not null && (filter.Nulls || nulls || filter.Rows.Length != 2))
                    throw new RequestException("INVALID_PARAMS", "Between takes two rows with distinct values, not NULL.");
                if (reps.Length == 0) throw new RequestException("INVALID_PARAMS", "Select at least one value that is not NULL to filter between.");
                reps = [reps[0], reps[^1]];
                nulls = false;
            }
            else if (reps.Length > MaxFilterValues)
                throw new RequestException("TOO_LARGE", "Select at most 4,096 different values to filter by.");
            else if (reps.Length == 0 && !nulls) throw new RequestException("INVALID_PARAMS", "A filter needs at least one value.");
            order = Keep(order, key, filter.Op, reps, nulls, token);
            resolved[f] = filter with { Rows = reps, Nulls = nulls, Cells = null };
        }
        if (keys.Count == 0 || order.Length <= 1) return (order, approximate, resolved);
        // Sort keys are built after the filters, over only the rows they kept (indexed by their place in kept, which is in
        // base row order, so ties still keep base row order); a Value key on a filtered column is the filter's own key. The
        // sorted positions (4 bytes a kept row) fit in the FilterBytes a row the filters reserved and no longer use.
        int[]? kept = null;
        if (order.Length < rows)
        {
            kept = order;
            Array.Sort(kept);
        }
        var built = new Key[keys.Count];
        var descending = new bool[keys.Count];
        for (var k = 0; k < keys.Count; k++)
        {
            descending[k] = keys[k].Descending;
            if (keys[k].Mode == SortMode.Value && values.TryGetValue(keys[k].Column, out var shared)) built[k] = kept is null ? shared : new MappedKey(shared, kept);
        }
        // Filter keys no sort key shares are done with: let them go before the sort keys are built.
        foreach (var (column, key) in values)
            if (!keys.Any(sort => sort.Mode == SortMode.Value && sort.Column == column)) key.Drop();
        values.Clear();
        for (var k = 0; k < keys.Count; k++)
            built[k] ??= Build(set, source, keys[k], kept, rows, token, ref approximate, memory);
        var comparer = new Comparer(built, descending, token);
        if (kept is null)
        {
            ThrowIfSlow(built, order);
            Sort(order, 0, order.Length, comparer);
            return (order, approximate, resolved);
        }
        var sorted = new int[kept.Length];
        for (var i = 0; i < sorted.Length; i++) sorted[i] = i;
        ThrowIfSlow(built, sorted);
        Sort(sorted, 0, sorted.Length, comparer);
        for (var i = 0; i < sorted.Length; i++) sorted[i] = kept[sorted[i]];
        return (sorted, approximate, resolved);
    }

    /// <summary>The base rows at the positions a selection names, ascending: what KeepRows keeps. Ranges are merged first, so
    /// a row is counted once however many name it; more than <see cref="MaxKeepRows"/> are refused before any is read.</summary>
    private static int[] Selected(ViewCells cells, int rows, CancellationToken token)
    {
        var spans = Merge(cells.Ranges, cells.Order?.Length ?? rows);
        long total = 0;
        foreach (var (first, end) in spans) total += end - first;
        if (total > MaxKeepRows) throw new RequestException("TOO_LARGE", "Select at most 4,095 rows to keep.");
        var picked = new int[total];
        var count = 0;
        foreach (var (first, end) in spans)
        {
            token.ThrowIfCancellationRequested();
            for (var position = first; position < end; position++)
            {
                var row = cells.Order is { } order ? order[position] : position;
                if (row < rows) picked[count++] = row;
            }
        }
        if (count == 0) throw new RequestException("INVALID_PARAMS", "Select at least one row to keep.");
        Array.Resize(ref picked, count);
        Array.Sort(picked);
        return picked;
    }

    /// <summary>Rows a KeepRows filter named, checked, ascending and each once.</summary>
    private static int[] Named(int[] named, int rows)
    {
        if (named.Length is 0 or > MaxKeepRows) throw new RequestException("INVALID_PARAMS", "A keepRows filter names 1 to 4,095 rows.");
        var sorted = (int[])named.Clone();
        Array.Sort(sorted);
        if (sorted[0] < 0 || sorted[^1] >= rows) throw new RequestException("INVALID_PARAMS", "A filter's rows must be rows of the result.");
        var unique = 0;
        for (var i = 0; i < sorted.Length; i++)
            if (unique == 0 || sorted[unique - 1] != sorted[i]) sorted[unique++] = sorted[i];
        Array.Resize(ref sorted, unique);
        return sorted;
    }

    /// <summary>The rows of <paramref name="order"/> among <paramref name="named"/> (ascending), in the order they have.</summary>
    private static int[] KeepRows(int[] order, int[] named, CancellationToken token)
    {
        var kept = new int[Math.Min(order.Length, named.Length)];
        var count = 0;
        for (var i = 0; i < order.Length; i++)
        {
            if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            if (Array.BinarySearch(named, order[i]) >= 0) kept[count++] = order[i];
        }
        Array.Resize(ref kept, count);
        return kept;
    }

    /// <summary>The base rows the cells name, one per distinct non-NULL value in ascending order, and whether one is NULL.</summary>
    private static (int[] Rows, bool Nulls) Pick(Key key, ViewCells cells, int rows, CancellationToken token)
    {
        // Overlapping ranges are merged first, so the cells read are at most the positions there are.
        var spans = Merge(cells.Ranges, cells.Order?.Length ?? rows);
        long total = 0;
        foreach (var (first, end) in spans) total += end - first;
        var picked = new int[total];
        var count = 0;
        var nulls = false;
        foreach (var (first, end) in spans)
        {
            for (var position = first; position < end; position++)
            {
                if ((position & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var row = cells.Order is { } order ? order[position] : position;
                if (row >= rows) continue;
                if (key.IsNull(row)) nulls = true;
                else picked[count++] = row;
            }
        }
        return (Unique(key, picked, count, token), nulls);
    }

    /// <summary>[first, count] ranges as sorted, disjoint [first, end) spans of the positions below <paramref name="length"/>.</summary>
    internal static List<(int First, int End)> Merge(IReadOnlyList<(long First, long Count)> ranges, int length)
    {
        var spans = new List<(int First, int End)>(ranges.Count);
        foreach (var (first, count) in ranges)
        {
            var end = Math.Min(length, first + count);
            if (first < end) spans.Add(((int)first, (int)end));
        }
        spans.Sort((a, b) => a.First.CompareTo(b.First));
        var merged = new List<(int First, int End)>(spans.Count);
        foreach (var span in spans)
        {
            if (merged.Count > 0 && span.First <= merged[^1].End) merged[^1] = (merged[^1].First, Math.Max(merged[^1].End, span.End));
            else merged.Add(span);
        }
        return merged;
    }

    /// <summary>Rows a request named, checked and reduced to one per distinct value in ascending order.</summary>
    private static (int[] Rows, bool Nulls) Distinct(Key key, int[] named, int rows, CancellationToken token)
    {
        var picked = new int[named.Length];
        var count = 0;
        var nulls = false;
        foreach (var row in named)
        {
            if (row < 0 || row >= rows) throw new RequestException("INVALID_PARAMS", "A filter's rows must be rows of the result.");
            if (key.IsNull(row)) nulls = true;
            else picked[count++] = row;
        }
        return (Unique(key, picked, count, token), nulls);
    }

    /// <summary>The first <paramref name="count"/> rows, sorted and reduced in place to one per distinct value.</summary>
    private static int[] Unique(Key key, int[] rows, int count, CancellationToken token)
    {
        ThrowIfSlow([key], rows.AsSpan(0, count));
        Sort(rows, 0, count, new Comparer([key], null, token));
        var unique = 0;
        for (var i = 0; i < count; i++)
            if (unique == 0 || key.Compare(rows[unique - 1], rows[i]) != 0) rows[unique++] = rows[i];
        Array.Resize(ref rows, unique);
        return rows;
    }

    private static int[] Keep(int[] order, Key key, FilterOp op, int[] reps, bool nulls, CancellationToken token)
    {
        var kept = new int[order.Length];
        var count = 0;
        for (var i = 0; i < order.Length; i++)
        {
            if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            var row = order[i];
            bool keep;
            if (key.IsNull(row)) keep = op == FilterOp.In ? nulls : op == FilterOp.NotIn && !nulls;
            else if (op == FilterOp.Between) keep = key.Compare(row, reps[0]) >= 0 && key.Compare(row, reps[1]) <= 0;
            else keep = Contains(key, reps, row) == (op == FilterOp.In);
            if (keep) kept[count++] = row;
        }
        Array.Resize(ref kept, count);
        return kept;
    }

    private static bool Contains(Key key, int[] reps, int row)
    {
        int low = 0, high = reps.Length - 1;
        while (low <= high)
        {
            var mid = (low + high) >>> 1;
            var compared = key.Compare(reps[mid], row);
            if (compared == 0) return true;
            if (compared < 0) low = mid + 1;
            else high = mid - 1;
        }
        return false;
    }

    /// <summary>The rows whose values in the columns equal another row's (NULL equal to NULL, as GROUP BY has it), each
    /// group together in the order of its first row and its rows in their order.</summary>
    private static int[] Duplicates(int[] order, Key[] columns, CancellationToken token)
    {
        if (columns is [{ Coded: true } only] && Duplicates(order, only, token) is { } grouped) return grouped;
        var positions = new int[order.Length];
        for (var i = 0; i < positions.Length; i++) positions[i] = i;
        var equal = new Comparer(columns, null, token);
        int Same(int a, int b) => equal.Values(order[a], order[b]);
        ThrowIfSlow(columns, order);
        Sort(positions, 0, positions.Length, Comparer<int>.Create((a, b) => Same(a, b) is var c && c != 0 ? c : a.CompareTo(b)));
        // Each group is a run of positions whose first is its first row's (ties keep their order); a run's start names it.
        var starts = new List<int>();
        var total = 0;
        for (var start = 0; start < positions.Length;)
        {
            var end = start + 1;
            while (end < positions.Length && Same(positions[start], positions[end]) == 0) end++;
            if (end - start > 1)
            {
                starts.Add(start);
                total += end - start;
            }
            start = end;
        }
        starts.Sort((a, b) => positions[a].CompareTo(positions[b]));
        var kept = new int[total];
        var count = 0;
        foreach (var start in starts)
        {
            var first = positions[start];
            for (var i = start; i < positions.Length && (i == start || Same(first, positions[i]) == 0); i++) kept[count++] = order[positions[i]];
        }
        return kept;
    }

    /// <summary>Duplicates by one key whose codes are its values: rows are numbered by value as they are met (so the groups
    /// are already in the order of their first rows) and then put together, in one pass each. Null past
    /// <see cref="MaxGroups"/> values, which a sort then groups.</summary>
    private static int[]? Duplicates(int[] order, Key key, CancellationToken token)
    {
        var groups = new Dictionary<ulong, int>();
        var counts = new List<int>();
        var groupOf = new int[order.Length];
        var nulls = -1;
        for (var i = 0; i < order.Length; i++)
        {
            if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            var row = order[i];
            int group;
            if (key.IsNull(row))
            {
                if (nulls < 0)
                {
                    nulls = counts.Count;
                    counts.Add(0);
                }
                group = nulls;
            }
            else
            {
                ref var slot = ref System.Runtime.InteropServices.CollectionsMarshal.GetValueRefOrAddDefault(groups, key.Code(row), out var known);
                if (!known)
                {
                    if (counts.Count >= MaxGroups) return null;
                    slot = counts.Count;
                    counts.Add(0);
                }
                group = slot;
            }
            counts[group]++;
            groupOf[i] = group;
        }
        var places = new int[counts.Count];
        var total = 0;
        for (var group = 0; group < places.Length; group++)
        {
            places[group] = counts[group] > 1 ? total : -1;
            if (counts[group] > 1) total += counts[group];
        }
        var kept = new int[total];
        for (var i = 0; i < order.Length; i++)
            if (places[groupOf[i]] >= 0) kept[places[groupOf[i]]++] = order[i];
        return kept;
    }

    /// <summary>A key over every row (indexed by base row), or over only <paramref name="kept"/>'s rows, in ascending base
    /// row order (indexed by their place in it). Its direction is the comparer's: keys compare ascending.</summary>
    internal static Key Build(ResultSetBuffer set, PageSource source, ViewKey sort, int[]? kept, int rows, CancellationToken token, ref bool approximate, KeyMemory? memory = null)
    {
        var column = sort.Column;
        var meta = set.Columns[column];
        var wire = set.Wires[column];
        // Chars orders character, xml and json columns by length; Bytes those and binary ones (DATALENGTH). Others sort by value.
        var byLength = sort.Mode == SortMode.Chars ? IsText(meta) : sort.Mode == SortMode.Bytes && (wire == WireKind.Binary || IsText(meta));
        var kind = byLength ? KindFor(sort.Mode) : KindOf(meta, wire);
        var capacity = kept?.Length ?? rows;
        Key key = kind switch
        {
            Kind.Chars or Kind.Bytes => new LengthKey(capacity),
            Kind.Exact => new NumberKey(capacity, kept, source, column, exact: true),
            Kind.Approximate => new NumberKey(capacity, kept, source, column, exact: false),
            Kind.Ticks => new TicksKey(capacity),
            Kind.Guid => new GuidKey(capacity),
            Kind.Collated when Culture(meta.Collation) is { } culture => new CollatedKey(capacity, kept, source, column, culture.Info, culture.Options, memory),
            _ => new OrdinalKey(capacity, kept, source, column, memory, trim: meta.Collation is not null)
        };
        // The date and time types' text is fixed-width, so its byte order is its instants': read as ticks, 8 bytes are the
        // whole value. A cell written any other way (or of another width than the first) gives the key back to its bytes.
        if (kind == Kind.Ordinal && wire == WireKind.Text && TypeName(meta) is "date" or "datetime" or "datetime2" or "smalldatetime" or "time")
            key = new InstantKey(capacity, TypeName(meta) == "time");
        var lengths = set.Lengths[column];
        // Each page's rows in the key: its own, or the kept rows that fall in it (kept is in base row order).
        int[]? starts = null;
        if (kept is not null)
        {
            starts = new int[source.Count + 1];
            var next = 0;
            for (var index = 0; index < source.Count; index++)
            {
                var page = source.Page(index);
                starts[index] = next;
                while (next < kept.Length && kept[next] < page.FirstRow + page.Rows) next++;
            }
            starts[source.Count] = next;
        }
        // Pages are independent: each is read once, in order, on whichever thread takes it. A key that gave up ranking its
        // values asks for the pages again.
        var inexact = 0;
        using var threads = Gate.Take(Math.Min(Workers, source.Count));
        bool again;
        do
        {
        again = false;
        key.Begin();
        do
            threads.For(source.Count, () => new Scratch(), (index, scratch) =>
            {
                var page = source.Page(index);
                var first = (int)page.FirstRow;
                var (start, stop) = starts is null ? (first, first + page.Rows) : (starts[index], starts[index + 1]);
                if (start == stop) return;
                var view = source.View(index);
                key.BeginPage(scratch, index);
                for (var row = start; row < stop; row++)
                {
                    var r = (kept is null ? row : kept[row]) - first;
                    if (view.IsNull(column, r))
                    {
                        key.SetNull(row);
                        key.Skip(row, scratch);
                        continue;
                    }
                    var span = view.Span(column, r);
                    var truncated = view.IsTruncated(column, r);
                    if (kind is Kind.Chars or Kind.Bytes)
                    {
                        CellSize size;
                        if (page.Lengths.TryCell(r, column, out var cell)) size = new CellSize(cell.Chars, cell.Bytes, cell.Exact && !lengths.Estimated);
                        else
                        {
                            size = lengths.Derive(span, wire);
                            if (truncated || lengths.Rule == LengthRule.Recorded) size = size with { Exact = false };
                        }
                        if (!size.Exact) Volatile.Write(ref inexact, 1);
                        ((LengthKey)key).Values[row] = kind == Kind.Chars ? size.Chars : size.Bytes;
                        continue;
                    }
                    if (truncated) Volatile.Write(ref inexact, 1);
                    key.Set(row, span, scratch);
                }
                key.EndPage(scratch, index);
            }, token);
        while (key.Finish());
        if (key is InstantKey { Declined: true })
        {
            key = new OrdinalKey(capacity, kept, source, column, memory, trim: meta.Collation is not null);
            again = true;
        }
        } while (again);
        if (inexact != 0) approximate = true;
        return key;
    }

    internal enum Kind { Exact, Approximate, Ticks, Guid, Collated, Ordinal, Chars, Bytes }

    private static Kind KindFor(SortMode mode) => mode == SortMode.Chars ? Kind.Chars : Kind.Bytes;

    /// <summary>A column's type name without its size or precision ("decimal(18,2)" is decimal), in lower case.</summary>
    internal static string TypeName(ResultColumn column)
    {
        var type = column.DataType;
        var cut = type.IndexOf('(');
        return (cut < 0 ? type : type[..cut]).Trim().ToLowerInvariant();
    }

    /// <summary>A column whose lengths a Chars or Bytes key may sort by: character types, xml and json.</summary>
    internal static bool IsText(ResultColumn column) => column.Collation is not null || column.Role is "xml" or "json"
        || TypeName(column) is "char" or "varchar" or "nchar" or "nvarchar" or "text" or "ntext" or "sysname" or "xml" or "json";

    internal static Kind KindOf(ResultColumn column, WireKind wire)
    {
        if (wire == WireKind.Binary) return Kind.Ordinal;
        return TypeName(column) switch
        {
            "bit" or "tinyint" or "smallint" or "int" or "bigint" or "decimal" or "numeric" or "money" or "smallmoney" => Kind.Exact,
            "real" or "float" => Kind.Approximate,
            "datetimeoffset" => Kind.Ticks,
            "uniqueidentifier" => Kind.Guid,
            "char" or "varchar" or "nchar" or "nvarchar" or "text" or "ntext" or "sysname" when column.Collation is not null => Kind.Collated,
            _ => Kind.Ordinal
        };
    }

    /// <summary>The comparison a collation implies, or null for code-point order (_BIN, _BIN2, or a locale this runtime does
    /// not know).</summary>
    internal static (CompareInfo Info, CompareOptions Options)? Culture(ResultCollation? collation)
    {
        // SqlCompareOptions: BinarySort2 16384, BinarySort 32768.
        if (collation is null || (collation.Options & (16384 | 32768)) != 0) return null;
        CompareInfo info;
        try { info = CultureInfo.GetCultureInfo(collation.Lcid).CompareInfo; }
        catch (CultureNotFoundException) { return null; }
        var options = CompareOptions.None;
        if ((collation.Options & 1) != 0) options |= CompareOptions.IgnoreCase;
        if ((collation.Options & 2) != 0) options |= CompareOptions.IgnoreNonSpace;
        if ((collation.Options & 8) != 0) options |= CompareOptions.IgnoreKanaType;
        if ((collation.Options & 16) != 0) options |= CompareOptions.IgnoreWidth;
        return (info, options);
    }

    /// <summary>A UTF-8 cell without its trailing spaces (U+0020), which SQL Server's comparisons ignore.</summary>
    internal static ReadOnlySpan<byte> TrimEnd(ReadOnlySpan<byte> utf8)
    {
        var end = utf8.Length;
        while (end > 0 && utf8[end - 1] == (byte)' ') end--;
        return utf8[..end];
    }

    /// <summary>Compares exact numeric display text (an optional '-', digits, an optional '.' and digits) at any precision,
    /// as decimal(38) values exceed both double and System.Decimal.</summary>
    internal static int CompareNumericText(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        var negativeA = a.Length > 0 && a[0] == (byte)'-';
        var negativeB = b.Length > 0 && b[0] == (byte)'-';
        if (negativeA) a = a[1..];
        if (negativeB) b = b[1..];
        if (IsZero(a)) negativeA = false;
        if (IsZero(b)) negativeB = false;
        if (negativeA != negativeB) return negativeA ? -1 : 1;
        var magnitude = CompareMagnitude(a, b);
        return negativeA ? -magnitude : magnitude;
    }

    private static bool IsZero(ReadOnlySpan<byte> digits)
    {
        foreach (var c in digits) if (c is >= (byte)'1' and <= (byte)'9') return false;
        return true;
    }

    private static int CompareMagnitude(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        var pointA = a.IndexOf((byte)'.');
        var pointB = b.IndexOf((byte)'.');
        var intA = (pointA < 0 ? a : a[..pointA]).TrimStart((byte)'0');
        var intB = (pointB < 0 ? b : b[..pointB]).TrimStart((byte)'0');
        if (intA.Length != intB.Length) return intA.Length < intB.Length ? -1 : 1;
        var compared = intA.SequenceCompareTo(intB);
        if (compared != 0) return Math.Sign(compared);
        var fracA = (pointA < 0 ? [] : a[(pointA + 1)..]).TrimEnd((byte)'0');
        var fracB = (pointB < 0 ? [] : b[(pointB + 1)..]).TrimEnd((byte)'0');
        return Math.Sign(fracA.SequenceCompareTo(fracB));
    }

    /// <summary>Reads the date and time types' display text as the backend writes it, without the general parser (which
    /// is several times slower and allocates for every cell): <c>yyyy-MM-dd</c>, <c>HH:mm:ss</c> with up to seven
    /// fraction digits, both with a space between, and a <c>+hh:mm</c> or <c>-hh:mm</c> offset after a space. False for
    /// anything else, which the general parser then reads. <paramref name="ticks"/> is the date and time as written.</summary>
    internal static bool TryInstant(ReadOnlySpan<byte> text, out long ticks, out long offset, out bool dated, out bool zoned)
    {
        ticks = 0;
        offset = 0;
        dated = false;
        zoned = false;
        static bool Number(ReadOnlySpan<byte> digits, out int value)
        {
            value = 0;
            foreach (var digit in digits)
            {
                if (digit is < (byte)'0' or > (byte)'9') return false;
                value = value * 10 + (digit - '0');
            }
            return true;
        }
        var at = 0;
        if (text.Length >= 10 && text[4] == (byte)'-' && text[7] == (byte)'-')
        {
            if (!Number(text[..4], out var year) || !Number(text.Slice(5, 2), out var month) || !Number(text.Slice(8, 2), out var day)) return false;
            if (year < 1 || month is < 1 or > 12 || day < 1 || day > DateTime.DaysInMonth(year, month)) return false;
            ticks = new DateTime(year, month, day).Ticks;
            dated = true;
            at = 10;
            if (at == text.Length) return true;
            if (text[at++] != (byte)' ') return false;
        }
        if (text.Length - at < 8 || text[at + 2] != (byte)':' || text[at + 5] != (byte)':') return false;
        if (!Number(text.Slice(at, 2), out var hour) || !Number(text.Slice(at + 3, 2), out var minute) || !Number(text.Slice(at + 6, 2), out var second)) return false;
        if (hour > 23 || minute > 59 || second > 59) return false;
        ticks += hour * TimeSpan.TicksPerHour + minute * TimeSpan.TicksPerMinute + second * TimeSpan.TicksPerSecond;
        at += 8;
        if (at < text.Length && text[at] == (byte)'.')
        {
            var start = ++at;
            long fraction = 0;
            for (; at < text.Length && at - start < 7 && text[at] is >= (byte)'0' and <= (byte)'9'; at++) fraction = fraction * 10 + (text[at] - '0');
            if (at == start) return false;
            for (var digits = at - start; digits < 7; digits++) fraction *= 10;
            ticks += fraction;
        }
        if (at == text.Length) return true;
        if (text.Length - at != 7 || text[at] != (byte)' ' || text[at + 1] is not ((byte)'+' or (byte)'-') || text[at + 4] != (byte)':') return false;
        if (!Number(text.Slice(at + 2, 2), out var hours) || !Number(text.Slice(at + 5, 2), out var minutes) || hours > 14 || minutes > 59 || (hours == 14 && minutes > 0)) return false;
        offset = (hours * 60L + minutes) * TimeSpan.TicksPerMinute * (text[at + 1] == (byte)'-' ? -1 : 1);
        zoned = true;
        return true;
    }

    /// <summary>A datetimeoffset's UTC instant from its display text, or null when it is not written as the backend writes it.</summary>
    internal static long? UtcTicks(ReadOnlySpan<byte> text) =>
        TryInstant(text, out var ticks, out var offset, out var dated, out var zoned) && dated && zoned && ticks - offset is >= 0 and <= 3155378975999999999 ? ticks - offset : null;

    /// <summary>The first 8 bytes of a span, big-endian, so that comparing two prefixes as numbers orders them as their spans
    /// would (a shorter span pads with zeros, so equal prefixes still need the spans themselves).</summary>
    internal static ulong Prefix(ReadOnlySpan<byte> bytes)
    {
        Span<byte> eight = stackalloc byte[8];
        eight.Clear();
        bytes[..Math.Min(8, bytes.Length)].CopyTo(eight);
        return BinaryPrimitives.ReadUInt64BigEndian(eight);
    }

    /// <summary>The 16 bytes of a uniqueidentifier in the order SQL Server compares them: bytes 10–15, 8–9, 6–7, 4–5, then
    /// 0–3 of its storage (Guid.TryWriteBytes's order), most significant first.</summary>
    internal static (ulong High, ulong Low) GuidOrder(Guid value)
    {
        Span<byte> stored = stackalloc byte[16];
        value.TryWriteBytes(stored);
        Span<byte> ordered = stackalloc byte[16];
        stored[10..16].CopyTo(ordered);
        stored[8..10].CopyTo(ordered[6..]);
        stored[6..8].CopyTo(ordered[8..]);
        stored[4..6].CopyTo(ordered[10..]);
        stored[0..4].CopyTo(ordered[12..]);
        return (BinaryPrimitives.ReadUInt64BigEndian(ordered), BinaryPrimitives.ReadUInt64BigEndian(ordered[8..]));
    }

    /// <summary>The sealed pages a sort reads, each parsed once, and a row's cell found again by binary search.</summary>
    internal sealed class PageSource
    {
        private readonly StoredPage[] pages;
        private readonly long[] starts;
        private readonly int[][] layouts;
        private readonly int[] blobStarts;
        private readonly int columns;

        public PageSource(StoredPage[] pages, int columns)
        {
            this.pages = pages;
            this.columns = columns;
            starts = new long[pages.Length];
            layouts = new int[pages.Length][];
            blobStarts = new int[pages.Length];
            for (var i = 0; i < pages.Length; i++)
            {
                starts[i] = pages[i].FirstRow;
                var view = PageView.Parse(pages[i].Body, columns);
                layouts[i] = view.Layout;
                blobStarts[i] = view.BlobStart;
            }
        }

        public int Count => pages.Length;
        public StoredPage Page(int index) => pages[index];

        public IEnumerable<(int Index, StoredPage Page)> Pages()
        {
            for (var i = 0; i < pages.Length; i++) yield return (i, pages[i]);
        }

        public PageView View(int index) => PageView.At(pages[index].Body, blobStarts[index], layouts[index], pages[index].FirstRow, pages[index].Rows, columns);

        /// <summary>Row <paramref name="row"/>'s stored bytes in a column (empty for NULL).</summary>
        public ReadOnlySpan<byte> Cell(int row, int column)
        {
            var index = Array.BinarySearch(starts, (long)row);
            if (index < 0) index = ~index - 1;
            return View(index).Span(column, (int)(row - starts[index]));
        }

        /// <summary>The page holding row <paramref name="row"/>, and the row's place in it (its flags as well as its cells).</summary>
        public PageView ViewOf(int row, out int local)
        {
            var index = Array.BinarySearch(starts, (long)row);
            if (index < 0) index = ~index - 1;
            local = (int)(row - starts[index]);
            return View(index);
        }
    }

    /// <summary>A column's values in ascending order, indexed by base row or, built over some rows (<c>map</c>), by their
    /// place in that list; <see cref="Comparer"/> applies a sort key's direction.</summary>
    internal abstract class Key(int rows, int[]? map = null)
    {
        private readonly int[] nulls = new int[(rows + 31) / 32];
        // Pages are filled on several threads, and two pages' rows can share a word.
        public void SetNull(int row) => Interlocked.Or(ref nulls[row >> 5], 1 << (row & 31));
        public virtual bool IsNull(int row) => (nulls[row >> 5] & (1 << (row & 31))) != 0;
        /// <summary>The base row at an index, where a comparison reads the stored cell again.</summary>
        protected int Row(int index) => map is null ? index : map[index];
        /// <summary>A row's value, from the thread filling its page: rows of one page come in order, on one thread.</summary>
        public abstract void Set(int row, ReadOnlySpan<byte> cell, Scratch scratch);
        /// <summary>A NULL row of the page being filled.</summary>
        public virtual void Skip(int row, Scratch scratch) { }
        public virtual void BeginPage(Scratch scratch, int page) { }
        public virtual void EndPage(Scratch scratch, int page) { }
        /// <summary>Before the first page: what the key learns from a sample of its rows.</summary>
        public virtual void Begin() { }
        /// <summary>Every page is filled. True to fill them all again (the key changed how it holds its rows).</summary>
        public virtual bool Finish() => false;
        /// <summary>How the key holds its rows, for the checks.</summary>
        public virtual string Layout => "";
        /// <summary>Whether 8 bytes a row are the whole value: two rows that are not NULL compare equal exactly when their
        /// <see cref="Code"/>s are equal, so rows can be grouped by them without a sort.</summary>
        public virtual bool Coded => false;
        public virtual ulong Code(int row) => 0;
        /// <summary>The share of comparisons expected to read both cells again from their pages (<see cref="ThrowIfSlow"/>).</summary>
        public virtual double TieShare => 0;
        /// <summary>Gives back what the key holds beyond its rows' fixed bytes; it compares no more.</summary>
        public virtual void Drop() { }
        /// <summary>Two non-NULL rows, ascending.</summary>
        public abstract int Compare(int a, int b);
    }

    private sealed class LengthKey(int rows) : Key(rows)
    {
        public readonly long[] Values = new long[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell, Scratch scratch) { }
        public override int Compare(int a, int b) => Values[a].CompareTo(Values[b]);
        public override bool Coded => true;
        public override ulong Code(int row) => (ulong)Values[row];
    }

    /// <summary>A number's double; for exact numerics, equal doubles (rounding is monotonic, so unequal ones already order
    /// the values) compare their text exactly. Only while a value may have more than <see cref="DoubleDigits"/> significant
    /// digits, though: up to that many a double tells any two values apart, so equal doubles are equal values, and a
    /// column of repeated values (a status, a flag, a foreign key) sorts without two reads of the pages per tie.</summary>
    private sealed class NumberKey(int rows, int[]? map, PageSource source, int column, bool exact) : Key(rows, map)
    {
        /// <summary>The significant decimal digits every double keeps (DBL_DIG); a cell this long or shorter has no more.</summary>
        internal const int DoubleDigits = 15;
        private readonly double[] values = new double[rows];
        // Set by the first cell whose double may not be the whole value (too long, or not a number).
        private bool textTies;
        public override void Set(int row, ReadOnlySpan<byte> cell, Scratch scratch)
        {
            var parsed = double.TryParse(cell, NumberStyles.Float, CultureInfo.InvariantCulture, out var value);
            values[row] = parsed ? value : double.NaN;
            if (!parsed || cell.Length > DoubleDigits) textTies = true;
        }
        public override int Compare(int a, int b)
        {
            var compared = values[a].CompareTo(values[b]);
            if (compared != 0 || !exact || !textTies) return compared;
            return CompareNumericText(source.Cell(Row(a), column), source.Cell(Row(b), column));
        }
        public override bool Coded => !exact || !textTies;
        /// <summary>The double's bits, with the two zeros as one and every NaN as one, as they compare.</summary>
        public override ulong Code(int row)
        {
            var value = values[row];
            return BitConverter.DoubleToUInt64Bits(value == 0 ? 0 : double.IsNaN(value) ? double.NaN : value);
        }
    }

    private sealed class TicksKey(int rows) : Key(rows)
    {
        private readonly long[] values = new long[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell, Scratch scratch)
        {
            if (UtcTicks(cell) is { } instant) { values[row] = instant; return; }
            Span<char> chars = stackalloc char[64];
            var length = Encoding.UTF8.GetChars(cell[..Math.Min(cell.Length, 64)], chars);
            values[row] = DateTimeOffset.TryParse(chars[..length], CultureInfo.InvariantCulture, DateTimeStyles.None, out var value) ? value.UtcTicks : long.MinValue;
        }
        public override int Compare(int a, int b) => values[a].CompareTo(values[b]);
        public override bool Coded => true;
        public override ulong Code(int row) => (ulong)values[row];
    }

    /// <summary>A date or time by its ticks, read from its fixed-width text (<see cref="TryInstant"/>): the order its bytes
    /// give, in 8 bytes that are the whole value. <see cref="Declined"/> once a cell is written another way, or is not as
    /// long as the first: its bytes order it then.</summary>
    private sealed class InstantKey(int rows, bool timeOnly) : Key(rows)
    {
        private readonly long[] values = new long[rows];
        private int width, declined;
        public bool Declined => declined != 0;
        public override string Layout => "ticks";
        public override void Set(int row, ReadOnlySpan<byte> cell, Scratch scratch)
        {
            var first = Interlocked.CompareExchange(ref width, cell.Length, 0);
            if ((first != 0 && first != cell.Length) || !TryInstant(cell, out var ticks, out _, out var dated, out var zoned) || zoned || dated == timeOnly)
            {
                Volatile.Write(ref declined, 1);
                return;
            }
            values[row] = ticks;
        }
        public override int Compare(int a, int b) => values[a].CompareTo(values[b]);
        public override bool Coded => true;
        public override ulong Code(int row) => (ulong)values[row];
    }

    private sealed class GuidKey(int rows) : Key(rows)
    {
        private readonly ulong[] high = new ulong[rows];
        private readonly ulong[] low = new ulong[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell, Scratch scratch)
        {
            Span<char> chars = stackalloc char[40];
            var length = Encoding.UTF8.GetChars(cell[..Math.Min(cell.Length, 40)], chars);
            (high[row], low[row]) = Guid.TryParse(chars[..length], out var value) ? GuidOrder(value) : (0UL, 0UL);
        }
        public override int Compare(int a, int b)
        {
            var compared = high[a].CompareTo(high[b]);
            return compared != 0 ? compared : low[a].CompareTo(low[b]);
        }
    }

    /// <summary>What one thread filling a key's pages reuses from page to page.</summary>
    internal sealed class Scratch
    {
        public char[] Chars = new char[256];
        public byte[] SortKey = new byte[512];
        /// <summary>The page's sort keys end to end, <see cref="Used"/> bytes of them.</summary>
        public byte[] Keys = [];
        public int Used;
        public int Page;
    }

    private sealed class ByteComparer : IEqualityComparer<byte[]>, IAlternateEqualityComparer<ReadOnlySpan<byte>, byte[]>, IComparer<byte[]>
    {
        public static readonly ByteComparer Instance = new();
        public bool Equals(byte[]? a, byte[]? b) => a.AsSpan().SequenceEqual(b);
        public int GetHashCode(byte[] value) => GetHashCode(value.AsSpan());
        public bool Equals(ReadOnlySpan<byte> alternate, byte[] other) => alternate.SequenceEqual(other);
        public int GetHashCode(ReadOnlySpan<byte> alternate)
        {
            var hash = new HashCode();
            hash.AddBytes(alternate);
            return hash.ToHashCode();
        }
        public byte[] Create(ReadOnlySpan<byte> alternate) => alternate.ToArray();
        public int Compare(byte[]? a, byte[]? b) => a.AsSpan().SequenceCompareTo(b);
    }

    /// <summary>A key whose order is the byte order of each row's value in some form (<see cref="Bytes"/>): a collation's
    /// sort key, or the value's own bytes. It holds its rows in one of three ways that a sample of them chooses between
    /// (<see cref="Begin"/>).
    /// <para>Ranked, when values repeat (a status, a category, a day): each distinct value is numbered as it is met, the
    /// distinct values are sorted once, and a row keeps its value's rank, so every comparison is of two integers. Past
    /// its limit of values (65,536, or one in 32 rows), or a refusal of the room for them, the pages are filled again
    /// another way.</para>
    /// <para>Otherwise 8 bytes of each value, after the bytes most of the sampled values start with (values that share
    /// their first characters, as names, paths, codes and the dates of one month do). When the sample says those 8 bytes
    /// tell nearly every row apart, that is all; when it says they do not, the rest of each value is kept too while the
    /// budget has room, a block a page, so that equal 8 bytes compare bytes. A row whose value starts otherwise is
    /// marked, keeps its value whole, and compares by it. Without the blocks (not wanted, or refused, which lets them all
    /// go at once), equal 8 bytes and marked rows read their cells again from their pages.</para></summary>
    private abstract class BytesKey(int rows, int[]? map, PageSource source, int column, KeyMemory? memory) : Key(rows, map)
    {
        /// <summary>The most distinct values a key ranks, whatever its rows; more when they are many (one in 32).</summary>
        internal const int MinRanked = 1 << 16;
        /// <summary>Charged per distinct value while ranking, besides its bytes.</summary>
        private const int RankedOverhead = 64;
        protected readonly PageSource Source = source;
        protected readonly int Column = column;
        // A row's rank, or 8 bytes of its value after the shared ones.
        private readonly ulong[] prefixes = new ulong[rows];
        // Where each row's value starts: its page's block (the high half) and the offset in it. A row's value ends where
        // the next row's starts, or with the block.
        private long[]? offsets;
        private byte[][]? blocks;
        // The bytes most sampled values start with, and the rows whose values start otherwise.
        private byte[] shared = [];
        private int[]? odd;
        private int odds;
        private bool ranked, wanted;
        private int rankLimit;
        private System.Collections.Concurrent.ConcurrentDictionary<byte[], int>? ranks;
        private System.Collections.Concurrent.ConcurrentDictionary<byte[], int>.AlternateLookup<ReadOnlySpan<byte>> rankOf;
        private int nextRank;
        private long rankHeld;
        private int abandoned;
        private int refused;
        private long held;
        private double tieShare;

        /// <summary>The cell as the bytes whose order is the key's; they may lie in the scratch, until its next use.</summary>
        protected abstract ReadOnlySpan<byte> Bytes(ReadOnlySpan<byte> cell, Scratch scratch);
        /// <summary>Two rows' cells, read again from their pages and compared.</summary>
        protected abstract int Cells(int a, int b);

        public override string Layout => (ranked ? "ranked" : blocks is null ? "prefix" : "whole") + ", " + shared.Length + " shared, " + odds + " odd";

        public override void Begin()
        {
            var count = prefixes.Length;
            var scratch = new Scratch();
            var values = new List<byte[]>();
            foreach (var place in Places(count, Sampled))
            {
                var view = Source.ViewOf(Row(place), out var local);
                if (!view.IsNull(Column, local)) values.Add(Bytes(view.Span(Column, local), scratch).ToArray());
            }
            values.Sort(ByteComparer.Instance);
            var taken = values.Count;
            var distinct = taken == 0 ? 0 : 1;
            for (var i = 1; i < taken; i++) if (!values[i].AsSpan().SequenceEqual(values[i - 1])) distinct++;
            // Values that repeat in a sample this small are few among all the rows.
            rankLimit = Math.Max(MinRanked, count / 32);
            ranked = taken - distinct >= 2 && Distinct(distinct, taken, count) <= rankLimit;
            // The longest start seven in eight of the sampled values share: sorted, such values lie side by side, and a
            // run's shared start is that of its first and last. A few values that start otherwise (empty ones, a
            // different kind of code) do not take it from the rest.
            if (taken > 1)
            {
                var run = taken - taken / 8;
                int best = 0, at = 0;
                for (var i = 0; i + run <= taken; i++)
                {
                    var length = values[i].AsSpan().CommonPrefixLength(values[i + run - 1]);
                    if (length > best) (best, at) = (length, i);
                }
                shared = values[at][..best];
            }
            // Whether 8 bytes after those tell the rows apart: when about two rows or fewer hold each, the few ties are
            // cheaper read from their cells than every row's value is kept.
            var starts = new HashSet<ulong>();
            var alike = 0;
            foreach (var value in values)
            {
                if (!value.AsSpan().StartsWith(shared)) continue;
                alike++;
                starts.Add(Prefix(value.AsSpan(shared.Length)));
            }
            wanted = alike > 0 && count / Math.Max(1, Distinct(starts.Count, alike, count)) > 2;
            if (ranked)
            {
                ranks = new(ByteComparer.Instance);
                rankOf = ranks.GetAlternateLookup<ReadOnlySpan<byte>>();
            }
            else Unranked();
        }

        private void Unranked()
        {
            odd = shared.Length > 0 ? new int[(prefixes.Length + 31) / 32] : null;
            if (!wanted) return;
            offsets = new long[prefixes.Length];
            blocks = new byte[Source.Count][];
        }

        public override void BeginPage(Scratch scratch, int page)
        {
            scratch.Used = 0;
            scratch.Page = page;
        }

        public override void Set(int row, ReadOnlySpan<byte> cell, Scratch scratch)
        {
            if (ranked)
            {
                if (Volatile.Read(ref abandoned) != 0) return;
                var value = Bytes(cell, scratch);
                if (!rankOf.TryGetValue(value, out var id))
                {
                    var bytes = value.Length + RankedOverhead;
                    if (Volatile.Read(ref nextRank) >= rankLimit || (memory is not null && !memory.TryReserve(bytes)))
                    {
                        Volatile.Write(ref abandoned, 1);
                        return;
                    }
                    Interlocked.Add(ref rankHeld, bytes);
                    id = ranks!.GetOrAdd(value.ToArray(), _ => Interlocked.Increment(ref nextRank) - 1);
                }
                prefixes[row] = (ulong)id;
                return;
            }
            var key = Bytes(cell, scratch);
            if (key.StartsWith(shared))
            {
                key = key[shared.Length..];
                prefixes[row] = Prefix(key);
            }
            else
            {
                Interlocked.Or(ref odd![row >> 5], 1 << (row & 31));
                Interlocked.Increment(ref odds);
            }
            if (offsets is not { } places || Volatile.Read(ref refused) != 0) return;
            if ((long)scratch.Used + key.Length > int.MaxValue) { Refuse(); return; }
            if (scratch.Used + key.Length > scratch.Keys.Length) Array.Resize(ref scratch.Keys, (int)Math.Min(int.MaxValue, Math.Max(2L * scratch.Keys.Length, Math.Max(scratch.Used + key.Length, 1 << 16))));
            key.CopyTo(scratch.Keys.AsSpan(scratch.Used));
            places[row] = (long)scratch.Page << 32 | (uint)scratch.Used;
            scratch.Used += key.Length;
        }

        public override void Skip(int row, Scratch scratch)
        {
            if (!ranked && offsets is { } places) places[row] = (long)scratch.Page << 32 | (uint)scratch.Used;
        }

        public override void EndPage(Scratch scratch, int page)
        {
            if (ranked || blocks is not { } all || Volatile.Read(ref refused) != 0) return;
            if (memory is not null && !memory.TryReserve(scratch.Used)) { Refuse(); return; }
            Interlocked.Add(ref held, scratch.Used);
            all[page] = scratch.Keys.AsSpan(0, scratch.Used).ToArray();
        }

        /// <summary>No room for a page's values: the ones kept go back at once, not when the pages are all read, so what
        /// else takes from the budget meanwhile (a query still loading) is not refused in their place.</summary>
        private void Refuse()
        {
            Volatile.Write(ref refused, 1);
            memory?.Return(Interlocked.Exchange(ref held, 0));
            if (blocks is { } all) Array.Clear(all);
        }

        public override bool Finish()
        {
            if (ranked)
            {
                var found = ranks!;
                ranks = null;
                rankOf = default;
                var charged = Interlocked.Exchange(ref rankHeld, 0);
                if (abandoned != 0)
                {
                    // More values than a key ranks, or no room for them: the other way, from the first page again.
                    memory?.Return(charged);
                    ranked = false;
                    abandoned = 0;
                    nextRank = 0;
                    Unranked();
                    return true;
                }
                // Ids are in the order values were met (and may skip a few, where two threads met one together).
                var keys = new byte[nextRank][];
                foreach (var (key, id) in found) keys[id] = key;
                var order = Enumerable.Range(0, keys.Length).Where(id => keys[id] is not null).ToArray();
                Array.Sort(order, (a, b) => keys[a].AsSpan().SequenceCompareTo(keys[b]));
                var rank = new ulong[keys.Length];
                for (var i = 0; i < order.Length; i++) rank[order[i]] = (ulong)i;
                if (rank.Length > 0)
                    for (var row = 0; row < prefixes.Length; row++) prefixes[row] = rank[prefixes[row]];
                memory?.Return(charged);
                return false;
            }
            if (refused != 0) Drop();
            if (blocks is not null) return false;
            // Without the values a tie reads its cells again, and so does a row marked odd: how many do is how many rows
            // share their 8 bytes or are marked, by a sample.
            const int sample = 1 << 16;
            var count = prefixes.Length;
            if (count < sample) return false;
            var seen = new HashSet<ulong>();
            int taken = 0, slow = 0;
            foreach (var row in Places(count, sample))
            {
                if (IsNull(row)) continue;
                taken++;
                if (IsOdd(row) || !seen.Add(prefixes[row])) slow++;
            }
            tieShare = taken == 0 ? 0 : (double)slow / taken;
            return false;
        }

        public override double TieShare => tieShare;
        public override bool Coded => ranked;
        public override ulong Code(int row) => prefixes[row];

        public override void Drop()
        {
            memory?.Return(Interlocked.Exchange(ref held, 0));
            blocks = null;
            offsets = null;
        }

        private bool IsOdd(int row) => odd is { } marks && (marks[row >> 5] & (1 << (row & 31))) != 0;

        private static ReadOnlySpan<byte> Whole(byte[][] blocks, long[] offsets, int row)
        {
            var at = offsets[row];
            var page = (int)(at >> 32);
            var block = blocks[page];
            var start = (int)(uint)at;
            var end = row + 1 < offsets.Length && (int)(offsets[row + 1] >> 32) == page ? (int)(uint)offsets[row + 1] : block.Length;
            return block.AsSpan(start, end - start);
        }

        public override int Compare(int a, int b)
        {
            if (odds != 0)
            {
                bool oddA = IsOdd(a), oddB = IsOdd(b);
                if (oddA || oddB)
                {
                    if (blocks is not { } all || offsets is not { } places) return Cells(a, b);
                    ReadOnlySpan<byte> x = Whole(all, places, a), y = Whole(all, places, b);
                    return oddA && oddB ? Math.Sign(x.SequenceCompareTo(y)) : oddA ? AgainstShared(x) : -AgainstShared(y);
                }
            }
            var compared = prefixes[a].CompareTo(prefixes[b]);
            if (compared != 0 || ranked) return compared;
            if (blocks is { } whole && offsets is { } starts) return Math.Sign(Whole(whole, starts, a).SequenceCompareTo(Whole(whole, starts, b)));
            return Cells(a, b);
        }

        /// <summary>A marked row's whole value against any value that starts with the shared bytes: they differ within
        /// those bytes, or the marked value ends there and so sorts first.</summary>
        private int AgainstShared(ReadOnlySpan<byte> key)
        {
            var length = Math.Min(key.Length, shared.Length);
            var compared = key[..length].SequenceCompareTo(shared.AsSpan(0, length));
            return compared != 0 ? Math.Sign(compared) : -1;
        }
    }

    /// <summary>A collation's order: by each value's sort key, and by the collation itself where cells are read again.</summary>
    private sealed class CollatedKey(int rows, int[]? map, PageSource source, int column, CompareInfo info, CompareOptions options, KeyMemory? memory)
        : BytesKey(rows, map, source, column, memory)
    {
        [ThreadStatic] private static char[]? left;
        [ThreadStatic] private static char[]? right;

        protected override ReadOnlySpan<byte> Bytes(ReadOnlySpan<byte> cell, Scratch scratch)
        {
            // The key may grow the buffer: its length first, then the buffer it is in.
            var written = SortKey(info, options, Decode(TrimEnd(cell), ref scratch.Chars!), ref scratch.SortKey);
            return scratch.SortKey.AsSpan(0, written);
        }

        // Sorts compare on several threads.
        protected override int Cells(int a, int b)
        {
            var x = Decode(TrimEnd(Source.Cell(Row(a), Column)), ref left);
            var y = Decode(TrimEnd(Source.Cell(Row(b), Column)), ref right);
            return Math.Sign(info.Compare(x, y, options));
        }

        private static ReadOnlySpan<char> Decode(ReadOnlySpan<byte> utf8, ref char[]? buffer)
        {
            if (buffer is null || buffer.Length < utf8.Length) buffer = new char[Math.Max(Math.Max(utf8.Length, 256), 2 * (buffer?.Length ?? 0))];
            return buffer.AsSpan(0, Encoding.UTF8.GetChars(utf8, buffer));
        }
    }

    /// <summary>Code-point order (UTF-8 bytes order as code points do), for binary values, _BIN and _BIN2 text and types
    /// with no collation, the date and time types' fixed-width text among them.</summary>
    private sealed class OrdinalKey(int rows, int[]? map, PageSource source, int column, KeyMemory? memory, bool trim)
        : BytesKey(rows, map, source, column, memory)
    {
        protected override ReadOnlySpan<byte> Bytes(ReadOnlySpan<byte> cell, Scratch scratch) => trim ? TrimEnd(cell) : cell;

        protected override int Cells(int a, int b)
        {
            var x = Source.Cell(Row(a), Column);
            var y = Source.Cell(Row(b), Column);
            if (trim)
            {
                x = TrimEnd(x);
                y = TrimEnd(y);
            }
            return Math.Sign(x.SequenceCompareTo(y));
        }
    }

    /// <summary>A key built over every row, read through a list of base rows: a filter's key serving a sort key that is
    /// built over only the rows the filters kept.</summary>
    private sealed class MappedKey(Key inner, int[] map) : Key(0)
    {
        public override bool IsNull(int row) => inner.IsNull(map[row]);
        public override void Set(int row, ReadOnlySpan<byte> cell, Scratch scratch) => throw new InvalidOperationException("A mapped key is built by its own.");
        public override int Compare(int a, int b) => inner.Compare(map[a], map[b]);
        public override double TieShare => inner.TieShare;
        public override void Drop() => inner.Drop();
        public override bool Coded => inner.Coded;
        public override ulong Code(int row) => inner.Code(map[row]);
    }

    /// <summary>The keys in order, each descending where <paramref name="descending"/> says (null: all ascending), NULL
    /// lowest, then the index, so equal rows keep their order (a stable sort).</summary>
    internal sealed class Comparer(Key[] keys, bool[]? descending, CancellationToken token) : IComparer<int>
    {
        // A sort compares on several threads: one counter between them would be the cache line they all write.
        [ThreadStatic] private static int calls;

        public int Compare(int a, int b)
        {
            var compared = Values(a, b);
            return compared != 0 ? compared : a.CompareTo(b);
        }

        /// <summary>The keys alone: 0 when the rows' values are equal.</summary>
        public int Values(int a, int b)
        {
            if (++calls == CancelEvery)
            {
                calls = 0;
                token.ThrowIfCancellationRequested();
            }
            for (var k = 0; k < keys.Length; k++)
            {
                var key = keys[k];
                var nullA = key.IsNull(a);
                var nullB = key.IsNull(b);
                int compared;
                if (nullA || nullB) compared = nullA == nullB ? 0 : nullA ? -1 : 1;
                else compared = key.Compare(a, b);
                if (compared != 0) return descending is not null && descending[k] ? -compared : compared;
            }
            return 0;
        }
    }
}

/// <summary>Pages in view order for results.read: up to 4,096 rows or 256 KiB each, as ingestion seals them, built from
/// each base row's stored cells (flags and truncation included) and numbered by view position. Each base page's header
/// is parsed once per read.</summary>
internal static class ViewPages
{
    public static IEnumerable<byte[]> Build(ResultView view, long firstRow, int maxRows)
    {
        foreach (var page in Stored(view, firstRow, maxRows)) yield return page.Body;
    }

    /// <summary>The same pages as stored pages numbered by view position (Copy and Save through a view), with no length
    /// sidecar, which neither reads.</summary>
    public static IEnumerable<StoredPage> Stored(ResultView view, long firstRow, int maxRows)
    {
        var set = view.Set;
        var end = Math.Min(view.Rows, firstRow + maxRows);
        if (firstRow >= end) yield break;
        var pages = set.SealedSnapshot();
        var starts = new long[pages.Length];
        for (var i = 0; i < pages.Length; i++) starts[i] = pages[i].FirstRow;
        var parsed = new Dictionary<int, (int[] Layout, int BlobStart)>();
        var columns = set.Wires.Count;
        var builder = new PageBuilder(set.ResultId, set.Wires, firstRow);
        var start = firstRow;
        for (var position = firstRow; position < end; position++)
        {
            var row = view.Order[position];
            var index = Array.BinarySearch(starts, (long)row);
            if (index < 0) index = ~index - 1;
            var page = pages[index];
            if (!parsed.TryGetValue(index, out var layout))
            {
                var first = PageView.Parse(page.Body, columns);
                parsed[index] = layout = (first.Layout, first.BlobStart);
            }
            Copy(builder, PageView.At(page.Body, layout.BlobStart, layout.Layout, page.FirstRow, page.Rows, columns), (int)(row - page.FirstRow), set.Wires);
            if (builder.IsFull)
            {
                yield return new StoredPage(start, (int)(position + 1 - start), builder.Seal(), PageLengths.Empty);
                start = position + 1;
                parsed.Clear();
            }
        }
        if (builder.HasRows) yield return new StoredPage(start, (int)(end - start), builder.Seal(), PageLengths.Empty);
    }

    private static void Copy(PageBuilder builder, PageView source, int row, IReadOnlyList<WireKind> wires)
    {
        builder.BeginRow();
        for (var c = 0; c < wires.Count; c++)
        {
            if (source.IsNull(c, row)) builder.AppendNull(source.IsError(c, row));
            else if (wires[c] == WireKind.Binary) builder.AppendBinary(source.Span(c, row), source.IsTruncated(c, row));
            else builder.AppendUtf8(source.Span(c, row), source.IsTruncated(c, row));
        }
        builder.CommitRow();
    }

    /// <summary>Each view position's row bytes (results.rowBytes through a view), with the positions whose sum is an estimate.</summary>
    public static long[] RowBytes(ResultView view, long firstRow, int count, List<long> estimated)
    {
        var end = Math.Min(view.Rows, firstRow + count);
        if (firstRow >= end) return [];
        var result = new long[end - firstRow];
        var row = new List<long>(1);
        for (var position = firstRow; position < end; position++)
        {
            row.Clear();
            var bytes = view.Set.RowBytes(view.Order[position], 1, row);
            result[position - firstRow] = bytes.Length == 1 ? bytes[0] : 0;
            if (row.Count > 0) estimated.Add(position);
        }
        return result;
    }
}
