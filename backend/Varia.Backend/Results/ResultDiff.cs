using System.Globalization;
using System.Runtime.InteropServices;

namespace Varia.Backend.Results;

/// <summary>An aligned entry's kind: the same row in both results, a row whose values changed, a row only in the second
/// result (added) or only in the first (removed).</summary>
internal enum DiffKind : byte { Same, Changed, Added, Removed }

/// <summary>An entry's marks: its key occurs more than once in either result, so it was paired in order (a guess).</summary>
[Flags]
internal enum DiffFlags : byte { None = 0, Repeated = 1 }

/// <summary>How results.diff matches rows: Auto (the first unique key candidate, else whole rows), Position (the n-th row
/// with the n-th), Rows (whole rows: the shared columns together) or Columns (a composite key of chosen pairs).</summary>
internal enum DiffMatchMode : byte { Auto, Position, Rows, Columns }

/// <summary>What results.diff was asked to match rows by: a mode, and for Columns 1 to <see cref="ResultDiffer.MaxKeyColumns"/>
/// distinct pair indexes.</summary>
internal sealed record DiffMatch(DiffMatchMode Mode, int[] Pairs)
{
    public static readonly DiffMatch Auto = new(DiffMatchMode.Auto, []);
}

/// <summary>One aligned entry: its kind, its row in each result (-1 where it has none), its differing cells,
/// DiffModel.Cells[CellStart .. CellStart + CellCount], and its flags. A matched row whose only differences are soft is
/// Same. The flags sit in the kind's padding: still 20 bytes an entry, as the working memory charges.</summary>
[StructLayout(LayoutKind.Explicit)]
internal readonly record struct DiffEntry([field: FieldOffset(0)] DiffKind Kind, [field: FieldOffset(4)] int Left, [field: FieldOffset(8)] int Right,
    [field: FieldOffset(12)] int CellStart = 0, [field: FieldOffset(16)] int CellCount = 0, [field: FieldOffset(1)] DiffFlags Flags = DiffFlags.None);

/// <summary>Two results aligned row by row (results.diff), in unified order: the second result's order, each removed row
/// after the first result's row it followed. The unified result is one rendering of it (<see cref="UnifiedDiff"/>); a
/// side-by-side one would read the same entries. <see cref="Pairs"/> are the shared columns (left, right) compared; an
/// entry's cells are pair indexes, negative (~index) for a soft difference: equal by the collation but not character for
/// character.</summary>
internal sealed class DiffModel(DiffEntry[] entries, (int Left, int Right)[] pairs, int[] cells, DiffMatchMode mode, int[] keyPairs, bool approximate)
{
    public DiffEntry[] Entries { get; } = entries;
    public (int Left, int Right)[] Pairs { get; } = pairs;
    public int[] Cells { get; } = cells;
    public ReadOnlySpan<int> CellsOf(DiffEntry entry) => Cells.AsSpan(entry.CellStart, entry.CellCount);
    /// <summary>How rows were matched: Auto with its key, or Rows when Auto found none; Position, Rows or Columns as asked.</summary>
    public DiffMatchMode Mode { get; } = mode;
    /// <summary>The pairs whose values matched rows: Auto's key or the chosen Columns; none for Rows and Position.</summary>
    public int[] KeyPairs { get; } = keyPairs;
    /// <summary>Auto's key pair, or -1 when whole rows matched (or another mode was asked).</summary>
    public int KeyPair => Mode == DiffMatchMode.Auto && KeyPairs.Length == 1 ? KeyPairs[0] : -1;
    /// <summary>A matched or compared value was a truncated value's stored prefix.</summary>
    public bool Approximate { get; } = approximate;
    /// <summary>Possible matches (look-alikes): a removed or added entry's index, and its partner's 0-based row in the other
    /// result. Both entries of a pair are listed.</summary>
    public IReadOnlyDictionary<int, int> Possible { get; init; } = new Dictionary<int, int>();
    /// <summary>Too many unmatched rows, or no memory for their values, to look for possible matches.</summary>
    public bool PossibleSkipped { get; init; }

    /// <summary>Entries whose key repeats (<see cref="DiffFlags.Repeated"/>).</summary>
    public long Repeated()
    {
        long repeated = 0;
        foreach (var entry in Entries) if ((entry.Flags & DiffFlags.Repeated) != 0) repeated++;
        return repeated;
    }

    /// <summary>Each pair's changed and soft cells, in pair order: the model's true counts, whatever a cut tone lists.</summary>
    public (long Changed, long Soft)[] ColumnChanges()
    {
        var changes = new (long Changed, long Soft)[Pairs.Length];
        foreach (var cell in Cells)
        {
            if (cell < 0) changes[~cell].Soft++;
            else changes[cell].Changed++;
        }
        return changes;
    }

    /// <summary>Entries of each kind, and soft differences (values equal only by collation).</summary>
    public (long Same, long Changed, long Added, long Removed, long Soft) Counts()
    {
        long same = 0, changed = 0, added = 0, removed = 0, soft = 0;
        foreach (var cell in Cells) if (cell < 0) soft++;
        foreach (var entry in Entries)
        {
            switch (entry.Kind)
            {
                case DiffKind.Same: same++; break;
                case DiffKind.Changed: changed++; break;
                case DiffKind.Added: added++; break;
                default: removed++; break;
            }
        }
        return (same, changed, added, removed, soft);
    }
}

/// <summary>Where one diff's time went, for the result-work benchmark (--result-work-bench): Stopwatch ticks spent on rows'
/// identities, matching them and aligning the matched rows (comparing their cells). Times only: nothing of the rows.</summary>
internal sealed class DiffStages
{
    public long Identity, Matching, Aligning;
    /// <summary>The first result was packed and read so far from its pages' order that it was unpacked in place.</summary>
    public bool Unpacked;
    /// <summary>Packed pages the unified result's writer had unpacked ahead on the workers, and those it unpacked itself.</summary>
    public long WrittenAhead, WrittenBehind;
}

/// <summary>Random access to a complete result's stored rows: each page's header is parsed once. Several threads may read
/// through one: a page's parsed header is published whole (two threads meeting an unparsed page may both parse it, alike).</summary>
internal sealed class RowAccess
{
    private readonly StoredPage[] pages;
    private readonly long[] starts;
    private readonly Parsed?[] parsed;
    private readonly int columns;

    public RowAccess(StoredPage[] pages, int columns)
    {
        this.pages = pages;
        this.columns = columns;
        starts = new long[pages.Length];
        parsed = new Parsed?[pages.Length];
        long rows = 0;
        for (var i = 0; i < pages.Length; i++) { starts[i] = pages[i].FirstRow; rows += pages[i].Rows; }
        Rows = rows;
    }

    public long Rows { get; }

    /// <summary>The page holding a row, and the row's index within it.</summary>
    public PageView At(long row, out int index) => At(row, out index, out _);

    /// <summary>The page holding a row, the row's index within it, and the page's lengths sidecar.</summary>
    public PageView At(long row, out int index, out PageLengths lengths)
    {
        var page = PageOf(row, out index);
        return Page(page, out lengths);
    }

    /// <summary>The index of the page holding a row, and the row's index within it: a caller that reads one row many times
    /// finds its page once and then reads it through <see cref="Page"/>.</summary>
    public int PageOf(long row, out int index)
    {
        var page = Array.BinarySearch(starts, row);
        if (page < 0) page = ~page - 1;
        index = (int)(row - pages[page].FirstRow);
        return page;
    }

    /// <summary>A page by its index (from <see cref="PageOf"/>), parsed once, and its lengths sidecar.</summary>
    public PageView Page(int page, out PageLengths lengths)
    {
        var stored = pages[page];
        lengths = stored.Lengths;
        if (Volatile.Read(ref parsed[page]) is not { } layout)
        {
            var body = stored.Body();
            var first = PageView.Parse(body, columns);
            Volatile.Write(ref parsed[page], layout = new Parsed(body, first.Layout, first.BlobStart));
        }
        return PageView.At(layout.Body, layout.BlobStart, layout.Layout, stored.FirstRow, stored.Rows, columns).With(stored.Lengths);
    }

    /// <summary>Reads the packed pages behind <paramref name="rows"/> (negative ones skipped) together
    /// (<see cref="ResultSetBuffer.BodiesTogether"/>: unpacked on the workers, charged as working memory) and keeps them, so
    /// a writer that visits those rows at random reads no packed page that nothing charges, and unpacks none twice. Returns
    /// the bytes reserved, which the caller gives back (<see cref="ResultSetBuffer.ReturnWork"/>). Refused, the result is
    /// unpacked in place (<see cref="ResultSetBuffer.TryUnpackAll"/>, 0 returned); TOO_LARGE with <paramref name="tooLarge"/>
    /// when that is refused too. The caller holds a pin.</summary>
    public long Hold(ResultSetBuffer set, IEnumerable<int> rows, string tooLarge, CancellationToken token)
    {
        if (!set.HasPacked) return 0;
        var wanted = new SortedSet<int>();
        foreach (var row in rows)
            if (row >= 0 && PageOf(row, out _) is var page && !Keeps(page)) wanted.Add(page);
        if (wanted.Count == 0) return 0;
        int[] list = [.. wanted];
        var bodies = set.BodiesTogether([.. list.Select(page => pages[page])], out var reserved, token);
        // Refused, the result is unpacked in place instead, as before fused reads: that adds only what packing saved,
        // where holding the pages charges their whole length (the packed copies stay).
        if (bodies is null) return set.TryUnpackAll(token) ? 0 : throw new RequestException("TOO_LARGE", tooLarge);
        for (var i = 0; i < list.Length; i++) Keep(list[i], bodies[i]);
        return reserved;
    }

    /// <summary>Whether a page by its index is kept parsed.</summary>
    public bool Keeps(int page) => Volatile.Read(ref parsed[page]) is not null;

    /// <summary>Keeps a page's bytes, read by the caller (unpacked together with others), as the page it reads.</summary>
    public void Keep(int page, byte[] body)
    {
        var first = PageView.Parse(body, columns);
        Volatile.Write(ref parsed[page], new Parsed(body, first.Layout, first.BlobStart));
    }

    private sealed record Parsed(byte[] Body, int[] Layout, int BlobStart);

    /// <summary>A reader of rows for one thread over a result that may be packed (<see cref="RowReader"/>).</summary>
    public RowReader Reader(PageRooms? rooms, int slots) => new(this, rooms, slots);

    /// <summary>One thread's rows of a result read fused: pages held as sealed (or kept, <see cref="Keep"/>) through the
    /// shared parsed headers, as <see cref="At(long, out int)"/> reads them; packed ones through a <see cref="RoomReader"/>
    /// of its own, which keeps the last <c>slots</c> pages it unpacked in its rooms, so rows read in about their pages'
    /// order unpack each page once. No packed page is unpacked through the set's cache and kept uncharged. With no rooms
    /// (no page was packed when the operation began) it reads exactly as <see cref="At(long, out int)"/> does.</summary>
    internal sealed class RowReader(RowAccess access, PageRooms? rooms, int slots) : IDisposable
    {
        private readonly RoomReader packed = new(rooms, access.columns, slots);
        private PageAhead? ahead;

        /// <summary>Packed pages this reader has unpacked.</summary>
        public long Unpacked => packed.Unpacked + AheadUnpacked;
        /// <summary>Packed pages unpacked ahead (<see cref="Ahead"/>).</summary>
        public long AheadUnpacked => aheadBefore + (ahead?.Unpacked ?? 0);
        private long aheadBefore;
        /// <summary>Packed pages this thread unpacked itself.</summary>
        public long Behind => packed.Unpacked;

        /// <summary>Reads the rows <paramref name="rows"/> lists (in the order this thread will ask for them, negative ones
        /// skipped) with their packed pages unpacked ahead on the workers (<see cref="PageAhead"/>), each page listed once a
        /// batch; a row asked for out of that order is read as before. The list of pages stops at a few uses a page, past which pages are read as before.</summary>
        public void Ahead(IEnumerable<int> rows, CancellationToken token)
        {
            if (rooms is null) return;
            var uses = new List<int>();
            var cap = 4 * access.pages.Length + 2 * ViewSorter.Workers;
            var batch = PageAhead.Batch;
            foreach (var row in rows)
            {
                if (row < 0) continue;
                var page = access.PageOf(row, out _);
                var stored = access.pages[page];
                if (access.Keeps(page) || stored.Set?.Raw(stored) is not null) continue;
                // A page the batch of the last one listed already lists is read from that batch again (PageAhead.TryRead
                // looks back over the batch being read), even once that batch is full: listed again, the reader would
                // never reach it, and would stop reading ahead.
                var listed = false;
                for (var u = uses.Count == 0 ? 0 : (uses.Count - 1) / batch * batch; u < uses.Count && !listed; u++) listed = uses[u] == page;
                if (listed) continue;
                if (uses.Count == cap) break;
                uses.Add(page);
            }
            ahead = PageAhead.TryStart(rooms.Set, access.pages, [.. uses], rooms.Length, access.columns, token);
        }

        public PageView At(long row, out int index) => At(row, out index, out _);

        public PageView At(long row, out int index, out PageLengths lengths)
        {
            var page = access.PageOf(row, out index);
            var stored = access.pages[page];
            if (rooms is null || access.Keeps(page) || stored.Set?.Raw(stored) is not null) return access.Page(page, out lengths);
            lengths = stored.Lengths;
            if (ahead is not null && ahead.TryRead(page, out var view)) return view;
            return packed.Read(stored);
        }

        /// <summary>Gives the rooms unpacked ahead back once the budget has no spare memory left, so the rows being written
        /// get the room they would have had without them (this reader then unpacks its pages itself), or once another
        /// operation unpacked the result in place (all of it at once), so nothing is left to unpack.</summary>
        public void YieldAhead()
        {
            if (ahead is null || (rooms!.Set.HasSpare && rooms.Set.HasPacked)) return;
            ahead.Dispose();
            aheadBefore += ahead.Unpacked;
            ahead = null;
        }

        public void Dispose()
        {
            ahead?.Dispose();
            packed.Dispose();
        }
    }
}

/// <summary>Aligns two complete results (results.diff). Columns pair by name (case-insensitively, in the first result's
/// order) when both hold text or both binary; a pair's values compare by the first result's column type and collation, so
/// a column whose type or collation changed between the results still matches. Rows match as <see cref="DiffMatch"/> asks:
/// Auto by the first candidate (RowIdentity.Candidates over the shared columns) that is unique, NULL-free and untruncated
/// in both results, else by whole rows (their shared columns' values together); Rows by whole rows; Columns by the chosen
/// pairs' values together (NULL matching NULL); Position the n-th row with the n-th. A key or whole row met more than once
/// matches in order, the k-th copy with the k-th; under Columns such entries are flagged. Values compare as SQL Server would
/// (CellHasher): numbers by value, text by its column's collation, unless <c>exact</c>, which compares text character for
/// character. Unmatched rows that look alike are then paired as possible matches (<see cref="LookAlikes"/>).</summary>
internal static class ResultDiffer
{
    private const int CancelEvery = 1 << 12;

    /// <summary>The most pairs a Columns match takes (limits.diff.maxKeyColumns).</summary>
    public const int MaxKeyColumns = 16;

    /// <summary>The look-alike search's bounds: removed rows, added rows, and removed × added × compared columns.</summary>
    public const int MaxLookAlikeRows = 1000;
    public const long MaxLookAlikeWork = 4_000_000;

    /// <summary>Bytes a Columns match adds per row while it runs, to find repeated keys: each row's key tagged with its side,
    /// sorted (8), and its flag (1).</summary>
    public const long RepeatBytes = 9;

    /// <summary>What results.diff answers (DIFF_KEY_TRUNCATED) when a chosen key column holds a truncated value.</summary>
    public const string KeyTruncated = "A key column holds values too long to compare. Choose another.";

    /// <summary>Bytes the alignment holds per row while it runs: a left row's identity, match, chain, place in its part and
    /// lookup entry with its bucket (8 + 4 + 4 + 4 + 24 + 4, and 6 for the lookups' sizes rounding up to a prime, up to a
    /// fifth more: the parts' lookups together hold one entry a left row), a right row's identity, match and place in its
    /// part (8 + 4 + 4), and up to one entry a row of both results (20), written straight into the model's array. Differing
    /// cells are charged as they are found (<see cref="CellBytes"/>).</summary>
    public static long WorkingBytes(long leftRows, long rightRows) => 54 * leftRows + 16 * rightRows + EntryBytes * (leftRows + rightRows);

    private const long EntryBytes = 20;

    /// <summary>Bytes one differing cell can hold at most while the alignment runs: its index in its run's list grown by
    /// doubling (twice 4), and once more in the model's array.</summary>
    public const long CellBytes = 12;

    /// <summary>Differing cells charged at a time, through Compare's <c>reserve</c>.</summary>
    public const int CellChunk = 1 << 16;

    /// <summary>The most shared columns a diff compares: the unified result adds a marker, two row numbers and a tone.</summary>
    public const int MaxPairs = PageBuilder.MaxColumns - UnifiedDiff.SuffixColumns;

    /// <summary>What results.diff answers (TOO_LARGE) when the budget has no room for its working memory, the rooms a packed
    /// result is read through, or unpacking its first result.</summary>
    public const string TooLarge = "There is not enough result memory to compare these results. Close other results and try again.";

    /// <summary>Packed pages of the first result each reader keeps unpacked while the alignment and the unified result read
    /// its rows in the second result's order: rows that moved a little (a parallel plan's chunks) still find their page.</summary>
    internal const int LeftSlots = 4;

    /// <summary>Packed pages of the second result each reader keeps: it reads them in order, so one, and one more for the
    /// unified result's pairs.</summary>
    internal const int RightSlots = 2;

    /// <summary>Unpacks of the first result's packed pages the alignment may make, per packed page, before it unpacks the
    /// first result in place instead: past that its rows are read so far from their pages' order (the results are sorted
    /// differently) that unpacking it once costs less time than finding its pages again.</summary>
    internal const int UnpacksPerPage = 4;

    /// <summary>The shared columns: each visible column of the first result with a visible column of the same name and wire
    /// (text or binary) in the second, in the first result's order. A column whose wire differs is one-sided: the unified
    /// result's cells take the second result's wire, which a first result's binary value could not be stored in.</summary>
    public static (int Left, int Right)[] Pairs(IReadOnlyList<ResultColumn> left, IReadOnlyList<ResultColumn> right, IReadOnlyList<WireKind>? leftWires = null, IReadOnlyList<WireKind>? rightWires = null)
    {
        var used = new bool[right.Count];
        var pairs = new List<(int, int)>();
        for (var l = 0; l < left.Count; l++)
        {
            if (ResultTextWriter.Hidden(left[l])) continue;
            for (var r = 0; r < right.Count; r++)
            {
                if (used[r] || ResultTextWriter.Hidden(right[r]) || !OrdinalNames.Same(left[l].Name, right[r].Name)) continue;
                if (leftWires is not null && rightWires is not null && leftWires[l] != rightWires[r]) continue;
                used[r] = true;
                pairs.Add((l, r));
                break;
            }
        }
        return [.. pairs];
    }

    /// <summary>Aligns the two results. <paramref name="reserve"/> is asked for <see cref="CellBytes"/> per differing cell,
    /// <see cref="CellChunk"/> cells at a time, beyond the <see cref="WorkingBytes"/> the caller reserved; a refusal fails
    /// the diff with TOO_LARGE, since every value of two wide results can differ.</summary>
    public static DiffModel Compare(ResultSetBuffer left, StoredPage[] leftPages, ResultSetBuffer right, StoredPage[] rightPages, bool exact, CancellationToken token,
        Func<long, bool>? reserve = null, DiffStages? stages = null, DiffMatch? match = null)
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        match ??= DiffMatch.Auto;
        using var leftPin = left.Pin();
        using var rightPin = right.Pin();
        var pairs = Pairs(left.Columns, right.Columns, left.Wires, right.Wires);
        if (pairs.Length == 0)
            throw new RequestException("INVALID_PARAMS", Pairs(left.Columns, right.Columns).Length == 0
                ? "These results have no column names in common, so they cannot be compared."
                : "The columns these results share hold binary data in one and text in the other, so they cannot be compared.");
        if (pairs.Length > MaxPairs)
            throw new RequestException("INVALID_PARAMS", "These results share more than " + MaxPairs.ToString("N0", CultureInfo.InvariantCulture) + " columns, more than a diff can show.");
        if (match.Mode == DiffMatchMode.Columns && (match.Pairs is not { Length: >= 1 and <= MaxKeyColumns } || match.Pairs.Any(pair => pair < 0 || pair >= pairs.Length) || match.Pairs.Distinct().Count() != match.Pairs.Length))
            throw new RequestException("INVALID_PARAMS", "Choose 1 to 16 different paired columns to match rows by.");
        long leftTotal = 0, rightTotal = 0;
        foreach (var page in leftPages) leftTotal += page.Rows;
        foreach (var page in rightPages) rightTotal += page.Rows;
        // The unified list holds a row of each at most: together they must fit one array.
        if (leftTotal > int.MaxValue / 2 || rightTotal > int.MaxValue / 2 || leftTotal + rightTotal > Array.MaxLength)
            throw new RequestException("TOO_LARGE", "These results have too many rows to compare.");
        var leftHasher = new CellHasher(left.Columns, left.Wires);
        // The second result's shared columns hash by the first's type, kind and collation, so equal values hash alike in both.
        var compared = right.Columns.ToArray();
        foreach (var (l, r) in pairs) compared[r] = compared[r] with { DataType = left.Columns[l].DataType, SortKind = left.Columns[l].SortKind, Collation = left.Columns[l].Collation };
        var rightHasher = new CellHasher(compared, right.Wires);
        // Position matching reads no identity.
        var positional = match.Mode == DiffMatchMode.Position;
        long[] leftIds = positional ? [] : new long[leftTotal];
        long[] rightIds = positional ? [] : new long[rightTotal];
        // Packed results are read fused: each reader unpacks the page it reads into a room of its own and both stay packed.
        using var leftOwned = PageRooms.Over(leftPages, left.Wires.Count, () => new RequestException("TOO_LARGE", TooLarge));
        var leftRooms = leftOwned;
        using var rightRooms = PageRooms.Over(rightPages, right.Wires.Count, () => new RequestException("TOO_LARGE", TooLarge));
        var mode = match.Mode;
        int[] keyPairs = [];
        var approximate = false;
        // How many key candidates it takes is not known ahead: no percentage until rows are matched.
        var progress = OperationProgress.Current;
        progress?.Phase("identify", 0.45, known: false);
        if (mode == DiffMatchMode.Auto)
        {
            var rightCandidates = RowIdentity.Candidates(right.Columns, right.Wires).ToHashSet();
            var tried = 0;
            foreach (var candidate in RowIdentity.Candidates(left.Columns, left.Wires))
            {
                var pair = Array.FindIndex(pairs, item => item.Left == candidate);
                if (pair < 0 || !rightCandidates.Contains(pairs[pair].Right)) continue;
                if (++tried > RowIdentity.MaxCandidates) break;
                var (leftUnique, leftApproximate) = RowIdentity.Fill(leftHasher, leftPages, candidate, leftIds, stopEarly: true, token, rooms: leftRooms);
                if (!leftUnique || leftApproximate) continue;
                var (rightUnique, rightApproximate) = RowIdentity.Fill(rightHasher, rightPages, pairs[pair].Right, rightIds, stopEarly: true, token, rooms: rightRooms);
                if (!rightUnique || rightApproximate) continue;
                keyPairs = [pair];
                break;
            }
            if (keyPairs.Length == 0) mode = DiffMatchMode.Rows;
        }
        if (mode == DiffMatchMode.Rows)
        {
            var leftColumns = pairs.Select(pair => pair.Left).ToArray();
            var rightColumns = pairs.Select(pair => pair.Right).ToArray();
            approximate |= Rows(leftHasher, leftPages, leftColumns, leftIds, token, leftRooms);
            approximate |= Rows(rightHasher, rightPages, rightColumns, rightIds, token, rightRooms);
        }
        else if (mode == DiffMatchMode.Columns)
        {
            // A composite key: the chosen pairs' values together, NULL hashing alike with NULL. A truncated value is only its
            // stored prefix, which could pair different rows: refused rather than guessed.
            keyPairs = [.. match.Pairs];
            if (Rows(leftHasher, leftPages, [.. keyPairs.Select(pair => pairs[pair].Left)], leftIds, token, leftRooms)
                || Rows(rightHasher, rightPages, [.. keyPairs.Select(pair => pairs[pair].Right)], rightIds, token, rightRooms))
                throw new RequestException("DIFF_KEY_TRUNCATED", KeyTruncated);
        }

        var matching = System.Diagnostics.Stopwatch.GetTimestamp();
        if (stages is not null) stages.Identity += matching - started;
        progress?.Phase("match", 0.55);
        bool[]? leftRepeated = null, rightRepeated = null;
        if (mode == DiffMatchMode.Columns)
        {
            if (reserve is not null && !reserve(RepeatBytes * (leftTotal + rightTotal))) throw new RequestException("TOO_LARGE", TooLarge);
            (leftRepeated, rightRepeated) = Repeats(leftIds, rightIds, token);
        }
        var (matchedLeft, rightMatch) = positional ? Positions((int)leftTotal, (int)rightTotal) : Match(leftIds, rightIds, token);
        progress?.Phase("align", 0.85);
        var aligning = System.Diagnostics.Stopwatch.GetTimestamp();
        if (stages is not null) stages.Matching += aligning - matching;
        if (leftRooms is not null && !Local(leftPages, rightMatch, token))
        {
            // Read in the second result's order, the first result's rows would unpack a page for most rows: it is unpacked
            // in place instead, as before fused reads, its rooms given back first (refused: TOO_LARGE, changing nothing).
            leftOwned!.Dispose();
            leftRooms = null;
            if (!left.TryUnpackAll(token)) throw new RequestException("TOO_LARGE", TooLarge);
            if (stages is not null) stages.Unpacked = true;
        }
        var (entries, cells) = Align(leftHasher, leftPages, rightHasher, rightPages, pairs, exact, matchedLeft, rightMatch, reserve, ref approximate, token, leftRooms, rightRooms);
        if (leftRepeated is not null && rightRepeated is not null)
        {
            for (var e = 0; e < entries.Length; e++)
            {
                if ((e & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var entry = entries[e];
                if ((entry.Left >= 0 && leftRepeated[entry.Left]) || (entry.Right >= 0 && rightRepeated[entry.Right])) entries[e] = entry with { Flags = entry.Flags | DiffFlags.Repeated };
            }
        }
        // Look-alikes are compared over the columns that did not match rows: none are left when every pair is a key, and
        // Position has no key to have changed.
        var possible = new Dictionary<int, int>();
        var skipped = false;
        if (mode != DiffMatchMode.Position)
        {
            int[] others = [.. Enumerable.Range(0, pairs.Length).Where(pair => !keyPairs.Contains(pair))];
            (possible, skipped) = LookAlikes(entries, pairs, others, leftHasher, leftPages, rightHasher, rightPages, reserve, token, leftRooms, rightRooms, exact);
        }
        if (stages is not null) stages.Aligning += System.Diagnostics.Stopwatch.GetTimestamp() - aligning;
        return new DiffModel(entries, pairs, cells, mode, keyPairs, approximate) { Possible = possible, PossibleSkipped = skipped };
    }

    /// <summary>Position matching: the n-th row of each result with the n-th of the other; the rest are added or removed.</summary>
    private static (int[] MatchedLeft, int[] RightMatch) Positions(int leftTotal, int rightTotal)
    {
        var matchedLeft = new int[leftTotal];
        var rightMatch = new int[rightTotal];
        for (var i = 0; i < leftTotal; i++) matchedLeft[i] = i < rightTotal ? i : -1;
        for (var j = 0; j < rightTotal; j++) rightMatch[j] = j < leftTotal ? j : -1;
        return (matchedLeft, rightMatch);
    }

    /// <summary>Which rows' keys occur more than once in either result. Each key is tagged with its side in its lowest bit
    /// and sorted; a run of one key with two copies on a side has its bits set, so that every copy of the key (both sides')
    /// then finds itself repeated by a binary search, the array staying sorted.</summary>
    internal static (bool[] Left, bool[] Right) Repeats(long[] leftIds, long[] rightIds, CancellationToken token)
    {
        var tagged = new long[leftIds.Length + rightIds.Length];
        for (var i = 0; i < leftIds.Length; i++) tagged[i] = leftIds[i] << 1;
        for (var j = 0; j < rightIds.Length; j++) tagged[leftIds.Length + j] = rightIds[j] << 1 | 1;
        token.ThrowIfCancellationRequested();
        Array.Sort(tagged);
        token.ThrowIfCancellationRequested();
        for (var start = 0; start < tagged.Length;)
        {
            var key = tagged[start] >> 1;
            int end = start, lefts = 0, rights = 0;
            for (; end < tagged.Length && tagged[end] >> 1 == key; end++)
                if ((tagged[end] & 1) == 0) lefts++; else rights++;
            var repeated = lefts > 1 || rights > 1;
            for (var k = start; k < end; k++) tagged[k] = key << 1 | (repeated ? 1L : 0L);
            start = end;
        }
        var left = new bool[leftIds.Length];
        var right = new bool[rightIds.Length];
        for (var i = 0; i < left.Length; i++) left[i] = Array.BinarySearch(tagged, leftIds[i] << 1 | 1) >= 0;
        token.ThrowIfCancellationRequested();
        for (var j = 0; j < right.Length; j++) right[j] = Array.BinarySearch(tagged, rightIds[j] << 1 | 1) >= 0;
        return (left, right);
    }

    /// <summary>Possible matches (D5): removed and added rows whose <paramref name="compared"/> pairs mostly agree, the hint
    /// that a key changed. A pair qualifies when at least 75% of the compared columns hold equal values (NULL equal to NULL)
    /// and at least min(3, columns) of those are not NULL; it is kept only when each is the other's unique best (a tie on
    /// either side keeps neither). Skipped past <see cref="MaxLookAlikeRows"/> rows a side or <see cref="MaxLookAlikeWork"/>
    /// comparisons, or when the values read are refused as working memory: the answer says so. Never changes a kind. Values are
    /// equal as the diff compares them: with <paramref name="exact"/>, text equal only by its collation is not.</summary>
    internal static (Dictionary<int, int> Partners, bool Skipped) LookAlikes(DiffEntry[] entries, (int Left, int Right)[] pairs, int[] compared, CellHasher leftHasher, StoredPage[] leftPages,
        CellHasher rightHasher, StoredPage[] rightPages, Func<long, bool>? reserve, CancellationToken token, PageRooms? leftRooms = null, PageRooms? rightRooms = null, bool exact = false)
    {
        var partners = new Dictionary<int, int>();
        if (compared.Length == 0) return (partners, false);
        var removed = new List<int>();
        var added = new List<int>();
        for (var e = 0; e < entries.Length; e++)
        {
            if (entries[e].Kind == DiffKind.Removed) { if (removed.Count <= MaxLookAlikeRows) removed.Add(e); }
            else if (entries[e].Kind == DiffKind.Added && added.Count <= MaxLookAlikeRows) added.Add(e);
        }
        if (removed.Count == 0 || added.Count == 0) return (partners, false);
        var columns = compared.Length;
        if (removed.Count > MaxLookAlikeRows || added.Count > MaxLookAlikeRows || (long)removed.Count * added.Count * columns > MaxLookAlikeWork) return (partners, true);
        // Each value read is kept as its hash and whether it is NULL.
        if (reserve is not null && !reserve((removed.Count + added.Count) * (long)columns * 9)) return (partners, true);
        (ulong[] Hashes, bool[] Nulls) Read(List<int> rows, bool isLeft)
        {
            var hasher = isLeft ? leftHasher : rightHasher;
            var hashes = new ulong[rows.Count * columns];
            var nulls = new bool[rows.Count * columns];
            using var reader = new RowAccess(isLeft ? leftPages : rightPages, hasher.Count).Reader(isLeft ? leftRooms : rightRooms, isLeft ? LeftSlots : RightSlots);
            for (var k = 0; k < rows.Count; k++)
            {
                token.ThrowIfCancellationRequested();
                var entry = entries[rows[k]];
                var view = reader.At(isLeft ? entry.Left : entry.Right, out var at);
                for (var c = 0; c < columns; c++)
                {
                    var column = isLeft ? pairs[compared[c]].Left : pairs[compared[c]].Right;
                    nulls[k * columns + c] = view.IsNull(column, at);
                    var hash = hasher.CellValue(view, column, at);
                    // Exact text compares character for character (CompareCells), so its hash takes the bytes in too.
                    if (exact && hasher.IsText(column) && !nulls[k * columns + c]) hash ^= Bytes(view.Span(column, at));
                    hashes[k * columns + c] = hash;
                }
            }
            return (hashes, nulls);
        }
        static ulong Bytes(ReadOnlySpan<byte> span)
        {
            var hash = 14695981039346656037UL;
            foreach (var b in span) hash = (hash ^ b) * 1099511628211UL;
            return hash;
        }
        var (oldHashes, oldNulls) = Read(removed, true);
        var (newHashes, _) = Read(added, false);
        var needed = Math.Min(3, columns);
        // Each side's best score, its partner, and whether another tied it (-1: none qualified).
        var bestOld = new int[removed.Count];
        var partnerOld = new int[removed.Count];
        var tieOld = new bool[removed.Count];
        var bestNew = new int[added.Count];
        var partnerNew = new int[added.Count];
        var tieNew = new bool[added.Count];
        Array.Fill(bestOld, -1);
        Array.Fill(bestNew, -1);
        for (var r = 0; r < removed.Count; r++)
        {
            token.ThrowIfCancellationRequested();
            for (var a = 0; a < added.Count; a++)
            {
                int equal = 0, values = 0;
                for (var c = 0; c < columns; c++)
                {
                    if (oldHashes[r * columns + c] != newHashes[a * columns + c]) continue;
                    equal++;
                    if (!oldNulls[r * columns + c]) values++;
                }
                if (4L * equal < 3L * columns || values < needed) continue;
                if (equal > bestOld[r]) { bestOld[r] = equal; partnerOld[r] = a; tieOld[r] = false; }
                else if (equal == bestOld[r]) tieOld[r] = true;
                if (equal > bestNew[a]) { bestNew[a] = equal; partnerNew[a] = r; tieNew[a] = false; }
                else if (equal == bestNew[a]) tieNew[a] = true;
            }
        }
        for (var r = 0; r < removed.Count; r++)
        {
            if (bestOld[r] < 0 || tieOld[r]) continue;
            var a = partnerOld[r];
            if (tieNew[a] || partnerNew[a] != r) continue;
            partners[removed[r]] = entries[added[a]].Right;
            partners[added[a]] = entries[removed[r]].Left;
        }
        return (partners, false);
    }

    /// <summary>The runs the alignment splits the second result's rows into, one a thread asked for.</summary>
    private static int Runs(int rightTotal) => Math.Clamp(rightTotal / RowIdentity.MinSlice, 1, ViewSorter.Workers);

    /// <summary>Whether the alignment's readers, reading the first result's packed pages in the second result's order with
    /// <see cref="LeftSlots"/> pages each (a reader a run, as <see cref="Align"/> splits them), would unpack at most
    /// <see cref="UnpacksPerPage"/> times a packed page, and each reader its slots. Counted on the workers from the row
    /// numbers alone, reading no page; a run stops counting once the runs together are past the allowance.</summary>
    internal static bool Local(StoredPage[] leftPages, int[] rightMatch, CancellationToken token)
    {
        var access = new RowAccess(leftPages, 0);
        var packed = new bool[leftPages.Length];
        long packedPages = 0;
        for (var p = 0; p < leftPages.Length; p++)
            if (leftPages[p].Set is { } set && set.Raw(leftPages[p]) is null) { packed[p] = true; packedPages++; }
        var runs = Runs(rightMatch.Length);
        var allowed = UnpacksPerPage * packedPages + (long)runs * LeftSlots;
        long unpacks = 0;
        using var threads = ViewSorter.Gate.Take(runs);
        threads.For(runs, run =>
        {
            Span<int> held = stackalloc int[LeftSlots];
            Span<long> used = stackalloc long[LeftSlots];
            held.Fill(-1);
            long clock = 0, own = 0;
            for (int j = ViewSorter.RunStart(rightMatch.Length, run, runs), end = ViewSorter.RunStart(rightMatch.Length, run + 1, runs); j < end; j++)
            {
                if ((j & (CancelEvery - 1)) == 0)
                {
                    token.ThrowIfCancellationRequested();
                    if (Interlocked.Read(ref unpacks) + own > allowed) break;
                }
                var i = rightMatch[j];
                if (i < 0) continue;
                var page = access.PageOf(i, out _);
                if (!packed[page]) continue;
                var slot = 0;
                var hit = false;
                for (var k = 0; k < LeftSlots; k++)
                {
                    if (held[k] == page) { used[k] = ++clock; hit = true; break; }
                    if (used[k] < used[slot]) slot = k;
                }
                if (hit) continue;
                held[slot] = page;
                used[slot] = ++clock;
                own++;
            }
            Interlocked.Add(ref unpacks, own);
        }, token);
        return unpacks <= allowed;
    }

    /// <summary>Each right row's left row with its identity, the k-th copy to the k-th copy, and each left row's right row
    /// (-1 for none). Identities are hashes below 2^53, so their high bits split them evenly into parts, one a thread asked
    /// for. Each part's rows are gathered in order (<see cref="ByPart"/>), so a part's copies meet in the order one pass meets
    /// them and the answer is one pass's; each part then matches only its own rows, writing only them.</summary>
    private static (int[] MatchedLeft, int[] RightMatch) Match(long[] leftIds, long[] rightIds, CancellationToken token)
    {
        var matchedLeft = new int[leftIds.Length];
        Array.Fill(matchedLeft, -1);
        var rightMatch = new int[rightIds.Length];
        Array.Fill(rightMatch, -1);
        var next = new int[leftIds.Length];
        var parts = (int)Math.Clamp(Math.Max(leftIds.Length, rightIds.Length) / RowIdentity.MinSlice, 1, ViewSorter.Workers);
        using var threads = ViewSorter.Gate.Take(parts);
        var (leftRows, leftStarts) = ByPart(threads, leftIds, parts, token);
        var (rightRows, rightStarts) = ByPart(threads, rightIds, parts, token);
        threads.For(parts, part =>
        {
            // Each part's lookup holds as many entries as its left rows, together one a left row, as one lookup would.
            var heads = new Dictionary<long, int>(leftStarts[part + 1] - leftStarts[part]);
            for (var at = leftStarts[part + 1] - 1; at >= leftStarts[part]; at--)
            {
                if ((at & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var i = leftRows?[at] ?? at;
                ref var head = ref System.Runtime.InteropServices.CollectionsMarshal.GetValueRefOrAddDefault(heads, leftIds[i], out var known);
                next[i] = known ? head : -1;
                head = i;
            }
            for (var at = rightStarts[part]; at < rightStarts[part + 1]; at++)
            {
                if ((at & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var j = rightRows?[at] ?? at;
                ref var head = ref System.Runtime.InteropServices.CollectionsMarshal.GetValueRefOrNullRef(heads, rightIds[j]);
                if (System.Runtime.CompilerServices.Unsafe.IsNullRef(ref head) || head < 0) continue;
                rightMatch[j] = head;
                matchedLeft[head] = j;
                head = next[head];
            }
        }, token);
        return (matchedLeft, rightMatch);
    }

    private static int Part(long id, int parts) => (int)(id * parts >> 53);

    /// <summary>The rows by the part their identity is in, in row order within a part, and where each part starts: even
    /// runs of the rows each count their parts' rows, then place them after the earlier parts' and the earlier runs' (a
    /// stable counting sort, on the lease's threads). One part needs no order: null, and the rows are their own places.</summary>
    private static (int[]? Rows, int[] Starts) ByPart(ViewSorter.WorkerGate.Lease threads, long[] ids, int parts, CancellationToken token)
    {
        if (parts == 1) return (null, [0, ids.Length]);
        var runs = parts;
        // counts[run * parts + part]: a run's rows in a part, then where they go.
        var counts = new int[runs * parts];
        threads.For(runs, run =>
        {
            for (int i = ViewSorter.RunStart(ids.Length, run, runs), end = ViewSorter.RunStart(ids.Length, run + 1, runs); i < end; i++)
            {
                if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                counts[run * parts + Part(ids[i], parts)]++;
            }
        }, token);
        var starts = new int[parts + 1];
        var place = 0;
        for (var part = 0; part < parts; part++)
        {
            starts[part] = place;
            for (var run = 0; run < runs; run++)
            {
                var size = counts[run * parts + part];
                counts[run * parts + part] = place;
                place += size;
            }
        }
        starts[parts] = place;
        var rows = new int[ids.Length];
        threads.For(runs, run =>
        {
            for (int i = ViewSorter.RunStart(ids.Length, run, runs), end = ViewSorter.RunStart(ids.Length, run + 1, runs); i < end; i++)
            {
                if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                rows[counts[run * parts + Part(ids[i], parts)]++] = i;
            }
        }, token);
        return (rows, starts);
    }

    /// <summary>The entries in unified order: removed rows before the first match go first; then each right row, and after a
    /// matched one the left rows that followed its left row up to the next matched one. The right rows are split into even
    /// runs on the threads the gate has free: each run first counts its entries (so each knows where its own go in the one
    /// array), then compares its matched rows' cells with hashers and pages of its own into a list of its own; the lists are
    /// joined in run order and each entry's cells moved on by the cells of the runs before it: the entries and cells one
    /// pass makes. Each run charges its cells as it finds them, a chunk at a time.</summary>
    private static (DiffEntry[] Entries, int[] Cells) Align(CellHasher leftHasher, StoredPage[] leftPages, CellHasher rightHasher, StoredPage[] rightPages, (int Left, int Right)[] pairs,
        bool exact, int[] matchedLeft, int[] rightMatch, Func<long, bool>? reserve, ref bool approximate, CancellationToken token, PageRooms? leftRooms = null, PageRooms? rightRooms = null)
    {
        var leftTotal = matchedLeft.Length;
        var rightTotal = rightMatch.Length;
        var leading = 0;
        while (leading < leftTotal && matchedLeft[leading] < 0) leading++;
        var runs = Runs(rightTotal);
        using var threads = ViewSorter.Gate.Take(runs);
        int Start(int run) => ViewSorter.RunStart(rightTotal, run, runs);
        var places = new long[runs + 1];
        threads.For(runs, run =>
        {
            long count = 0;
            for (int j = Start(run), end = Start(run + 1); j < end; j++)
            {
                if ((j & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                count++;
                var i = rightMatch[j];
                if (i < 0) continue;
                for (var k = i + 1; k < leftTotal && matchedLeft[k] < 0; k++) count++;
            }
            places[run + 1] = count;
        }, token);
        places[0] = leading;
        for (var run = 0; run < runs; run++) places[run + 1] += places[run];
        var entries = new DiffEntry[places[runs]];
        for (var i = 0; i < leading; i++) entries[i] = new DiffEntry(DiffKind.Removed, i, -1);
        var found = new List<int>[runs];
        // One cache of parsed page headers a result, shared by the runs: one a run would hold up to a copy each.
        var leftAccess = new RowAccess(leftPages, leftHasher.Count);
        var rightAccess = new RowAccess(rightPages, rightHasher.Count);
        var cut = 0;
        var refused = 0;
        var charging = new object();
        long differing = 0, charged = 0;
        threads.For(runs, run =>
        {
            var (ownLeft, ownRight) = run == 0 ? (leftHasher, rightHasher) : (leftHasher.Fork(), rightHasher.Fork());
            // A run reads its second result's rows in order and the first result's in about their order (Local), so a few
            // pages kept unpacked a run serve them.
            using var leftReader = leftAccess.Reader(leftRooms, LeftSlots);
            using var rightReader = rightAccess.Reader(rightRooms, RightSlots);
            var cells = found[run] = [];
            var counted = 0;
            var at = (int)places[run];
            var inexact = false;
            for (int j = Start(run), end = Start(run + 1); j < end; j++)
            {
                if ((j & (CancelEvery - 1)) == 0)
                {
                    token.ThrowIfCancellationRequested();
                    // Another run was refused: the diff fails as a whole.
                    if (Volatile.Read(ref refused) != 0) return;
                }
                var i = rightMatch[j];
                if (i < 0) { entries[at++] = new DiffEntry(DiffKind.Added, -1, j); continue; }
                var before = cells.Count;
                inexact |= CompareCells(ownLeft, leftReader, i, ownRight, rightReader, j, pairs, exact, cells, out var hard);
                if (cells.Count > counted)
                {
                    // The runs' cells together, charged a chunk at a time as one pass charges them, however many runs find them.
                    var all = Interlocked.Add(ref differing, cells.Count - counted);
                    counted = cells.Count;
                    if (all > Volatile.Read(ref charged))
                        lock (charging)
                            while (all > charged)
                            {
                                if (reserve is not null && !reserve(CellChunk * CellBytes))
                                {
                                    Volatile.Write(ref refused, 1);
                                    throw new RequestException("TOO_LARGE", "These results differ in too many values to compare in the result memory left. Close other results and try again.");
                                }
                                Volatile.Write(ref charged, charged + CellChunk);
                            }
                }
                entries[at++] = new DiffEntry(hard ? DiffKind.Changed : DiffKind.Same, i, j, before, cells.Count - before);
                for (var k = i + 1; k < leftTotal && matchedLeft[k] < 0; k++) entries[at++] = new DiffEntry(DiffKind.Removed, k, -1);
            }
            if (inexact) Volatile.Write(ref cut, 1);
        }, token);
        if (cut != 0) approximate = true;
        var bases = new int[runs + 1];
        for (var run = 0; run < runs; run++) bases[run + 1] = checked(bases[run] + found[run].Count);
        var all = new int[bases[runs]];
        threads.For(runs, run =>
        {
            found[run].CopyTo(all, bases[run]);
            found[run] = [];
            var shift = bases[run];
            if (shift == 0) return;
            for (long e = places[run]; e < places[run + 1]; e++)
                if (entries[e].Kind is DiffKind.Same or DiffKind.Changed) entries[e] = entries[e] with { CellStart = entries[e].CellStart + shift };
        }, token);
        return (entries, all);
    }

    /// <summary>Each row's identity over the given columns.</summary>
    private static bool Rows(CellHasher hasher, StoredPage[] pages, int[] columns, long[] ids, CancellationToken token, PageRooms? rooms)
    {
        var cut = 0;
        RowIdentity.EachPage(hasher, pages, ids.Length, token, (own, page, view) =>
        {
            var inexact = false;
            for (var r = 0; r < page.Rows; r++) ids[page.FirstRow + r] = own.Row(view, r, columns, ref inexact) & RowIdentity.Mask;
            if (inexact) Volatile.Write(ref cut, 1);
        }, rooms);
        return cut != 0;
    }

    /// <summary>Appends the pairs whose values differ (~pair for a soft difference); whether a truncated value was compared.</summary>
    private static bool CompareCells(CellHasher leftHasher, RowAccess.RowReader leftAccess, int leftRow, CellHasher rightHasher, RowAccess.RowReader rightAccess, int rightRow,
        (int Left, int Right)[] pairs, bool exact, List<int> cells, out bool hard)
    {
        var approximate = false;
        hard = false;
        var leftView = leftAccess.At(leftRow, out var l);
        var rightView = rightAccess.At(rightRow, out var r);
        for (var p = 0; p < pairs.Length; p++)
        {
            var (lc, rc) = pairs[p];
            var leftNull = leftView.IsNull(lc, l);
            var rightNull = rightView.IsNull(rc, r);
            if (leftNull || rightNull)
            {
                if (leftNull != rightNull || leftView.IsError(lc, l) != rightView.IsError(rc, r)) { cells.Add(p); hard = true; }
                continue;
            }
            if (leftView.IsTruncated(lc, l) || rightView.IsTruncated(rc, r)) approximate = true;
            // Equal text is the same value unless a float or real's exact value, kept apart from its text, differs: read only
            // where the hashers read it (by the first result's types), so the cells compare as they hash.
            var x = 0d;
            var y = 0d;
            var leftExact = leftHasher.ReadsExact(lc) && leftView.TryExact(lc, l, out x);
            var rightExact = rightHasher.ReadsExact(rc) && rightView.TryExact(rc, r, out y);
            if (leftView.Span(lc, l).SequenceEqual(rightView.Span(rc, r)) && leftExact == rightExact && (!leftExact || x == y)) continue;
            var text = leftHasher.IsText(lc);
            // Values of other types that differ only in form (2.0 and 2.00) are the same value; text equal by its collation
            // is a soft difference, or a change when compared exactly. Values compare, not their hashes, which can collide.
            var equal = leftHasher.Same(leftView, lc, l, rightHasher, rightView, rc, r);
            if (equal && !text) continue;
            if (!equal || exact) { cells.Add(p); hard = true; }
            else cells.Add(~p);
        }
        return approximate;
    }
}

/// <summary>Renders a diff as a result (results.diff), unified like git: each entry of the model in order, a changed one
/// as its first result's row (−) then its second's (+), and only <c>context</c> unchanged rows around each change (all of
/// them with <c>context</c> -1). Its columns are the shared columns (the second result's names and types), then a hidden
/// suffix: the marker ("Change", role mark: " ", "−" or "+"), the entry's row in the first result ("Old row", role leftRow)
/// and in the second ("New row", role rightRow), 1-based and NULL where it has none (both halves of a changed entry carry
/// both), and the tone (role tone): its kind ("same", "added", "removed", or "changedOld" and "changedNew" for a change's
/// halves), its flags (<see cref="ToneFlags"/>), then the differing cells as pair indexes (which are the data columns'
/// indexes), a soft one with a leading "~"; NULL for an unchanged row with neither. The suffix is not
/// data: the grid draws it in the row header, and only Save writes it (ResultJobs). Each data cell's bytes are its source
/// cell's, so the row-size bar sums the values shown, not the suffix. Rows stop at the first one refused, and the set then
/// says why it was truncated: a full budget never stops between a changed row's two halves, though a page sealed under low
/// system memory can. results.diff refuses a diff cut short either way whole (SqlService.DiffAsync).
/// The one-row layout (<c>entry</c>) stores each entry once: a changed one as its second result's row with marker "~" and
/// tone kind "changed", followed after the data by a previous-value column per pair (role old, Of its pair; the first
/// result's type, collation and length rule) holding the first result's value in every changed cell, whether the tone lists
/// it or not, and NULL elsewhere (soft cells are not changed). A previous value is not measured for the row-size bar, but
/// counts toward the 8 MiB row limit: past it, it is truncated and marked so. Removed rows show the first result's values.
/// A cut row's full changed-pair list goes into the change index (<see cref="DiffIndex.ChangedPairs"/>).</summary>
internal static class UnifiedDiff
{
    public const string Removed = "−", Added = "+", Changed = "~";

    /// <summary>The longest tone text: under the 512 characters a grid reads of a cell (src/renderer/src/grid/constants.ts
    /// maxCellChars), so the grid always reads it whole. Runs of adjacent columns are listed as ranges, which keeps a row
    /// that differs everywhere short; a tone that would still be longer stops at a whole entry and ends with "…".</summary>
    public const int MaxToneChars = 500;

    /// <summary>Hidden suffix columns after the data columns: marker, the two row numbers and the tone.</summary>
    public const int SuffixColumns = 4;

    /// <summary>The most pairs the one-row layout takes: its data and previous-value columns and the suffix fill at most a
    /// page's columns (2p + 4 &lt;= 4,096; limits.diff.maxEntryPairs).</summary>
    public const int MaxEntryPairs = (PageBuilder.MaxColumns - SuffixColumns) / 2;

    /// <summary>What a previous-value column is named: its data column's name and this.</summary>
    public const string OldSuffix = " (old)";

    /// <summary>The columns of a layout: the shared columns (the second result's), in the one-row layout
    /// (<paramref name="entry"/>) a previous-value column per pair (the first result's column, role old), then the suffix.</summary>
    public static IReadOnlyList<ResultColumn> Columns(ResultSetBuffer left, ResultSetBuffer right, DiffModel model, bool entry)
    {
        var unified = Columns(right, model);
        if (!entry) return unified;
        var pairs = model.Pairs.Length;
        return [.. unified.Take(pairs), .. model.Pairs.Select((pair, p) => left.Columns[pair.Left] with { Name = right.Columns[pair.Right].Name + OldSuffix, Role = "old", Of = p }), .. unified.Skip(pairs)];
    }

    public static IReadOnlyList<WireKind> Wires(ResultSetBuffer left, ResultSetBuffer right, DiffModel model, bool entry) =>
        entry ? [.. model.Pairs.Select(pair => right.Wires[pair.Right]), .. model.Pairs.Select(pair => left.Wires[pair.Left]), WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Text] : Wires(right, model);

    public static IReadOnlyList<ColumnLength> Lengths(ResultSetBuffer left, ResultSetBuffer right, DiffModel model, bool entry) =>
        entry ? [.. model.Pairs.Select(pair => right.Lengths[pair.Right]), .. model.Pairs.Select(pair => left.Lengths[pair.Left]), ColumnLength.Utf16, ColumnLength.Utf16, ColumnLength.Utf16, ColumnLength.Utf16] : Lengths(right, model);

    public static IReadOnlyList<ResultColumn> Columns(ResultSetBuffer right, DiffModel model) =>
    [
        .. model.Pairs.Select(pair => right.Columns[pair.Right]),
        new("Change", "nvarchar(1)", "text", Role: "mark", MaxLength: 1),
        new("Old row", "bigint", "text", Role: "leftRow"),
        new("New row", "bigint", "text", Role: "rightRow"),
        new("", "nvarchar(" + MaxToneChars.ToString(CultureInfo.InvariantCulture) + ")", "text", Role: "tone", MaxLength: MaxToneChars)
    ];

    public static IReadOnlyList<WireKind> Wires(ResultSetBuffer right, DiffModel model) =>
        [.. model.Pairs.Select(pair => right.Wires[pair.Right]), WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Text];

    public static IReadOnlyList<ColumnLength> Lengths(ResultSetBuffer right, DiffModel model) =>
        [.. model.Pairs.Select(pair => right.Lengths[pair.Right]), ColumnLength.Utf16, ColumnLength.Utf16, ColumnLength.Utf16, ColumnLength.Utf16];

    /// <summary>The entries the unified result shows: every change, and up to <paramref name="context"/> unchanged entries on
    /// each side of one (all with -1).</summary>
    public static bool[] Shown(DiffModel model, int context)
    {
        var entries = model.Entries;
        var shown = new bool[entries.Length];
        if (context < 0) { Array.Fill(shown, true); return shown; }
        var last = int.MinValue / 2;
        for (var k = 0; k < entries.Length; k++)
        {
            if (entries[k] is { Kind: DiffKind.Same, CellCount: 0 }) continue;
            shown[k] = true;
            for (var b = Math.Max(Math.Max(0, k - context), last + 1); b < k; b++) shown[b] = true;
            last = k;
            for (var a = k + 1; a <= Math.Min(entries.Length - 1, k + context); a++) if (entries[a] is { Kind: DiffKind.Same, CellCount: 0 }) shown[a] = true; else break;
        }
        return shown;
    }

    /// <summary>The rows the unified result stores for <paramref name="context"/>: each entry shown, a changed one twice
    /// (once in the one-row layout, <paramref name="entry"/>).</summary>
    public static long StoredRows(DiffModel model, int context, bool entry = false)
    {
        var shown = Shown(model, context);
        long rows = 0;
        for (var k = 0; k < shown.Length; k++)
            if (shown[k]) rows += model.Entries[k].Kind == DiffKind.Changed && !entry ? 2 : 1;
        return rows;
    }

    /// <summary>Writes the rows into <paramref name="set"/> (opened with <see cref="Columns"/> and <see cref="Wires"/>), then
    /// completes it. Returns the unchanged entries left out after the last row stored (trailingHidden).</summary>
    /// <param name="tooLarge">What it answers (TOO_LARGE) when the budget has no room for the rooms a packed result is
    /// read through: each side's rows are read fused, a few pages kept unpacked (<see cref="ResultDiffer.LeftSlots"/>), in
    /// about the order the comparison read them.</param>
    /// <param name="index">Records each row stored, in order (<see cref="DiffIndex.Builder"/>), sized by <see cref="StoredRows"/>.</param>
    /// <param name="oneRow">The one-row layout (the set opened with its <see cref="Columns(ResultSetBuffer, ResultSetBuffer, DiffModel, bool)"/>).</param>
    public static long Write(ResultSetBuffer set, ResultSetBuffer left, StoredPage[] leftPages, ResultSetBuffer right, StoredPage[] rightPages, DiffModel model, int context, CancellationToken token,
        string tooLarge = ResultDiffer.TooLarge, DiffStages? stages = null, DiffIndex.Builder? index = null, bool oneRow = false)
    {
        using var leftPin = left.Pin();
        using var rightPin = right.Pin();
        using var leftRooms = PageRooms.Over(leftPages, left.Wires.Count, () => new RequestException("TOO_LARGE", tooLarge));
        using var rightRooms = PageRooms.Over(rightPages, right.Wires.Count, () => new RequestException("TOO_LARGE", tooLarge));
        using var leftReader = new RowAccess(leftPages, left.Wires.Count).Reader(leftRooms, ResultDiffer.LeftSlots);
        using var rightReader = new RowAccess(rightPages, right.Wires.Count).Reader(rightRooms, ResultDiffer.RightSlots);
        var sides = (Left: new Side(leftReader, model.Pairs, true, left.Lengths, right.Lengths),
            Right: new Side(rightReader, model.Pairs, false, right.Lengths, right.Lengths));
        // The one-row layout's previous values: NULL in every pair but a changed entry's changed ones.
        var none = oneRow ? new Old(sides.Left, -1, []) : null;
        var shown = Shown(model, context);
        // One thread writes the rows: each side's packed pages are unpacked ahead on the workers, in the order it reads them.
        IEnumerable<int> Read(bool isLeft)
        {
            for (var k = 0; k < model.Entries.Length; k++)
            {
                if (!shown[k]) continue;
                var entry = model.Entries[k];
                if (isLeft ? entry.Kind is DiffKind.Removed or DiffKind.Changed : entry.Kind is not DiffKind.Removed) yield return isLeft ? entry.Left : entry.Right;
            }
        }
        var tone = new System.Text.StringBuilder(64);
        var counter = 0;
        // Unchanged entries left out since the last row stored: the next row's gap flag, or what trails the last one.
        long omitted = 0;
        using var written = OperationProgress.Current?.Count((model.Entries.Length >> 10) + 1) ?? default;
        try
        {
            // Inside the try: a room refused while writing (TOO_LARGE) still completes the result with what it holds.
            leftReader.Ahead(Read(true), token);
            rightReader.Ahead(Read(false), token);
            for (var k = 0; k < model.Entries.Length; k++)
            {
                if (++counter == 1 << 10) { counter = 0; token.ThrowIfCancellationRequested(); written.Done(); }
                if (!shown[k]) { omitted++; continue; }
                // Before each row, not each thousand: one row can be up to a page.
                leftReader.YieldAhead();
                rightReader.YieldAhead();
                var entry = model.Entries[k];
                var cells = model.CellsOf(entry);
                var repeated = (entry.Flags & DiffFlags.Repeated) != 0;
                var partner = model.Possible.TryGetValue(k, out var row) ? row : -1;
                var gap = omitted;
                omitted = 0;
                bool stored;
                switch (entry.Kind)
                {
                    case DiffKind.Same:
                        stored = Row(set, sides.Right, entry.Right, " ", entry.Left, entry.Right, cells.IsEmpty && !repeated && gap == 0 ? null : Tone(tone, "same", Flags(repeated, -1, gap), cells), none);
                        if (stored) index?.Add(DiffRowKind.Same, repeated, false, 0);
                        break;
                    case DiffKind.Added:
                        stored = Row(set, sides.Right, entry.Right, Added, -1, entry.Right, Tone(tone, "added", Flags(repeated, partner, gap), []), none);
                        if (stored) index?.Add(DiffRowKind.Added, repeated, false, 1, DiffIndex.Builder.Key(entry.Right, true), partner < 0 ? -1 : DiffIndex.Builder.Key(partner, false));
                        break;
                    case DiffKind.Removed:
                        stored = Row(set, sides.Left, entry.Left, Removed, entry.Left, -1, Tone(tone, "removed", Flags(repeated, partner, gap), []), none);
                        if (stored) index?.Add(DiffRowKind.Removed, repeated, false, 1, DiffIndex.Builder.Key(entry.Left, false), partner < 0 ? -1 : DiffIndex.Builder.Key(partner, true));
                        break;
                    case DiffKind.Changed when none is not null:
                    {
                        // One row: the new values, the old ones after them, the units its tone lists and one more for a cut,
                        // whose full list of changed pairs the index keeps (reserved first: refused, the diff stops).
                        var changedTone = Tone(tone, "changed", Flags(repeated, -1, gap), cells, out var units, out var cut);
                        if (cut && index is not null && !index.TryCut()) { stored = false; break; }
                        stored = Row(set, sides.Right, entry.Right, Changed, entry.Left, entry.Right, changedTone, new Old(sides.Left, entry.Left, cells));
                        if (stored) index?.Add(DiffRowKind.Changed, repeated, cut, units + (cut ? 1 : 0), changed: cells, keepsList: cut);
                        break;
                    }
                    default:
                        // The gap is on the first row stored after the run: the old half. The units are on the new half,
                        // where navigation lands: the cells its tone lists, and one more when it was cut.
                        var oldTone = Tone(tone, "changedOld", Flags(repeated, -1, gap), cells, out _, out var oldCut);
                        var newTone = Tone(tone, "changedNew", Flags(repeated, -1, 0), cells, out var listed, out var newCut);
                        stored = Pair(set, sides, entry, oldTone, newTone);
                        if (stored)
                        {
                            index?.Add(DiffRowKind.ChangedOld, repeated, oldCut, 0);
                            index?.Add(DiffRowKind.ChangedNew, repeated, newCut, listed + (newCut ? 1 : 0));
                        }
                        break;
                }
                if (!stored) break;
            }
            return omitted;
        }
        finally
        {
            set.Complete();
            if (stages is not null)
            {
                stages.WrittenAhead = leftReader.AheadUnpacked + rightReader.AheadUnpacked;
                stages.WrittenBehind = leftReader.Behind + rightReader.Behind;
            }
        }
    }

    /// <summary>A row's tone flags: its key repeats (<c>dup</c>), its possible match's 0-based row in the other result
    /// (<c>poss=</c>, 1-based; -1 for none), and the unchanged entries left out just before it (<c>gap=</c>; 0 for none).</summary>
    internal readonly record struct ToneFlags(bool Repeated, int Partner, long Gap)
    {
        public static readonly ToneFlags None = new(false, -1, 0);
    }

    private static ToneFlags Flags(bool repeated, int partner, long gap) => new(repeated, partner, gap);

    /// <summary>The tone text with no flags.</summary>
    internal static string Tone(System.Text.StringBuilder tone, string kind, ReadOnlySpan<int> cells) => Tone(tone, kind, ToneFlags.None, cells);

    /// <summary>The tone text: the kind, its flags (at most three, 34 characters: <c>dup poss=&lt;n&gt; gap=&lt;n&gt;</c>), then the
    /// differing cells' pair indexes in order, each run of adjacent columns of one kind (changed, or soft with "~") as
    /// "first-last", cut at a whole entry with " …" so that the whole text, kind and flags included, is at most
    /// <see cref="MaxToneChars"/>.</summary>
    internal static string Tone(System.Text.StringBuilder tone, string kind, ToneFlags flags, ReadOnlySpan<int> cells) => Tone(tone, kind, flags, cells, out _, out _);

    /// <summary>As above, and the changed (not soft) cells it lists and whether it was cut: the row's change units
    /// (<see cref="DiffIndex"/>) are those cells, and one more for a cut.</summary>
    internal static string Tone(System.Text.StringBuilder tone, string kind, ToneFlags flags, ReadOnlySpan<int> cells, out int listed, out bool cut)
    {
        listed = 0;
        cut = false;
        tone.Clear().Append(kind);
        if (flags.Repeated) tone.Append(" dup");
        if (flags.Partner >= 0) tone.Append(" poss=").Append((flags.Partner + 1L).ToString(CultureInfo.InvariantCulture));
        if (flags.Gap > 0) tone.Append(" gap=").Append(flags.Gap.ToString(CultureInfo.InvariantCulture));
        Span<char> entry = stackalloc char[32];
        for (var i = 0; i < cells.Length;)
        {
            var soft = cells[i] < 0;
            var first = soft ? ~cells[i] : cells[i];
            var last = first;
            var j = i + 1;
            while (j < cells.Length && cells[j] < 0 == soft && (soft ? ~cells[j] : cells[j]) == last + 1) { last++; j++; }
            var length = 0;
            entry[length++] = ' ';
            if (soft) entry[length++] = '~';
            first.TryFormat(entry[length..], out var written, provider: CultureInfo.InvariantCulture);
            length += written;
            if (last > first)
            {
                entry[length++] = '-';
                last.TryFormat(entry[length..], out written, provider: CultureInfo.InvariantCulture);
                length += written;
            }
            if (tone.Length + length > MaxToneChars - 2) { tone.Append(" …"); cut = true; break; }
            tone.Append(entry[..length]);
            if (!soft) listed += last - first + 1;
            i = j;
        }
        return tone.ToString();
    }

    /// <summary>One result's side of the diff: its rows, which of each pair's columns is its, its columns' byte rules, and
    /// the unified result's (the second result's).</summary>
    private sealed record Side(RowAccess.RowReader Access, (int Left, int Right)[] Pairs, bool IsLeft, IReadOnlyList<ColumnLength> Rules, IReadOnlyList<ColumnLength> Shown)
    {
        public int Column(int pair) => IsLeft ? Pairs[pair].Left : Pairs[pair].Right;
    }

    /// <summary>A changed entry's two rows, "−" then "+": the budget is asked for room for both before either is written,
    /// so the result never holds one half of a change.</summary>
    private static bool Pair(ResultSetBuffer set, (Side Left, Side Right) sides, DiffEntry entry, string removedTone, string addedTone)
    {
        var bytes = RowBound(sides.Left, entry.Left, removedTone) + RowBound(sides.Right, entry.Right, addedTone);
        if (!set.TryReserveRows(bytes))
        {
            set.CountRow();
            set.CountRow();
            return false;
        }
        // Both halves carry both row numbers: the gutter draws each half's own side.
        return Row(set, sides.Left, entry.Left, Removed, entry.Left, entry.Right, removedTone, null)
            && Row(set, sides.Right, entry.Right, Added, entry.Left, entry.Right, addedTone, null);
    }

    /// <summary>At most what one row of the unified result stores: its cells' bytes, the marker, row numbers and tone, each
    /// cell's offset and a lengths entry for each, and its floats' exact values.</summary>
    private static long RowBound(Side side, int row, string tone)
    {
        var view = side.Access.At(row, out var at, out var lengths);
        long bytes = 3 + 2 * CellFormat.MaxFixedBytes + 3L * tone.Length;
        for (var p = 0; p < side.Pairs.Length; p++)
        {
            var c = side.Column(p);
            if (view.IsNull(c, at)) continue;
            bytes += view.Span(c, at).Length;
            // A float or real's exact value, kept beside the unified result's page.
            if (lengths.TryExact(at, c, out _)) bytes += PageLengths.ExactBytes;
        }
        return bytes + (4L + PageLengths.CellBytes) * (side.Pairs.Length + 4) + 4;
    }

    /// <summary>The one-row layout's previous values for a row: the first result's row (-1 for none) and the entry's
    /// differing cells (pair indexes in order, soft ones as ~index), whose changed ones get the first result's value.</summary>
    private sealed class Old(Side left, int row, ReadOnlySpan<int> cells)
    {
        public Side Left { get; } = left;
        public int Row { get; } = row;
        public int[] Cells { get; } = cells.ToArray();
    }

    /// <summary>Copies one source row's shared cells, each measured with its source cell's characters and bytes, then in
    /// the one-row layout (<paramref name="old"/>) its previous values (not measured), then its marker, row numbers and tone
    /// (not measured); false once the set stores no more.</summary>
    private static bool Row(ResultSetBuffer set, Side side, int row, string marker, int leftRow, int rightRow, string? tone, Old? old)
    {
        set.CountRow();
        var builder = set.BeginRow();
        if (builder is null) return false;
        var view = side.Access.At(row, out var at, out var lengths);
        var truncated = 0;
        // The marker and tone follow the data, so data reaching the row limit must leave them room to be stored whole.
        builder.ReserveRowBytes(SuffixBytes(marker, tone));
        for (var p = 0; p < side.Pairs.Length; p++)
        {
            var c = side.Column(p);
            if (view.IsNull(c, at)) { builder.AppendNull(view.IsError(c, at)); continue; }
            var cut = view.IsTruncated(c, at);
            if (cut) truncated++;
            var span = view.Span(c, at);
            if (view.Wire(c) == WireKind.Binary) builder.AppendBinary(span, cut);
            else builder.AppendUtf8(span, cut);
            // A float or real's exact value goes with its text, so the comparison sorts and filters as its inputs do.
            if (ColumnTypes.HoldsExact(set.Columns[p]) && lengths.TryExact(at, c, out var exact)) builder.KeepExact(exact);
            var rule = side.Rules[c];
            CellSize size;
            if (lengths.TryCell(at, c, out var kept)) size = new CellSize(kept.Chars, kept.Bytes, kept.Exact && !rule.Estimated);
            else
            {
                size = rule.Derive(span, view.Wire(c));
                if (cut) size = size with { Exact = false };
            }
            // Kept beside the page when the unified column's own rule would not give the source's size again.
            builder.Measure(size.Chars, size.Bytes, keep: rule.Rule == LengthRule.Recorded || !ReferenceEquals(rule, side.Shown[side.Pairs[p].Right]), exact: size.Exact);
        }
        if (old is not null) truncated += Previous(set, builder, old, side.Pairs.Length);
        builder.ReserveRowBytes(0);
        builder.AppendText(marker);
        Number(builder, leftRow);
        Number(builder, rightRow);
        if (tone is null) builder.AppendNull();
        else builder.AppendText(tone);
        return set.TryCommitRow(truncated);
    }

    /// <summary>Appends a row's previous values: the first result's value in each changed (not soft) pair, NULL in the
    /// others; returns how many were stored truncated (by the source's cap, or by the row limit, which they meet before
    /// the data does since they come after it).</summary>
    private static int Previous(ResultSetBuffer set, PageBuilder builder, Old old, int pairs)
    {
        var truncated = 0;
        PageView view = default;
        var at = 0;
        var lengths = PageLengths.Empty;
        if (old.Row >= 0) view = old.Left.Access.At(old.Row, out at, out lengths);
        var next = 0;
        for (var p = 0; p < pairs; p++)
        {
            while (next < old.Cells.Length && (old.Cells[next] < 0 ? ~old.Cells[next] : old.Cells[next]) < p) next++;
            var changed = old.Row >= 0 && next < old.Cells.Length && old.Cells[next] == p;
            if (!changed) { builder.AppendNull(); continue; }
            var c = old.Left.Column(p);
            if (view.IsNull(c, at)) { builder.AppendNull(view.IsError(c, at)); continue; }
            var span = view.Span(c, at);
            var cut = view.IsTruncated(c, at);
            if (view.Wire(c) == WireKind.Binary) builder.AppendBinary(span, cut);
            else builder.AppendUtf8(span, cut);
            if (ColumnTypes.HoldsExact(set.Columns[pairs + p]) && lengths.TryExact(at, c, out var exact)) builder.KeepExact(exact);
            if (builder.LastTruncated) truncated++;
        }
        return truncated;
    }

    /// <summary>The most a row's suffix adds after its data: the marker and tone as UTF-8, and two row numbers, which
    /// <see cref="PageBuilder.BeginFormatted"/> writes outside the row budget but still counts against the row.</summary>
    internal static int SuffixBytes(string marker, string? tone) => 3 * (marker.Length + (tone?.Length ?? 0)) + 2 * CellFormat.MaxFixedBytes;

    private static void Number(PageBuilder builder, int row)
    {
        if (row < 0) builder.AppendNull();
        else builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), row + 1L));
    }
}
