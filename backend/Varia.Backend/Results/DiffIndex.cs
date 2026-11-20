using System.Text;

namespace Varia.Backend.Results;

/// <summary>A diff's stored row's kind, as its tone names it: an unchanged row, a changed entry on one row (the one-row
/// layout), an added or removed row, or the old and new halves of a changed entry (two rows).</summary>
internal enum DiffRowKind : byte { Same = 0, Changed = 1, Added = 2, Removed = 3, ChangedOld = 4, ChangedNew = 5 }

/// <summary>The kinds a results.view <c>kind</c> filter keeps; a changed entry's halves are Changed.</summary>
[Flags]
internal enum DiffKindSet : byte { None = 0, Same = 1, Changed = 2, Added = 4, Removed = 8 }

/// <summary>A diff's change index (results.diff), written with its rows and kept on its set, charged to the query budget
/// with it and released with it: per stored row its kind, flags and change units (3 bytes), each look-alike row's partner
/// as a stored row of the diff, and a running total of units per <see cref="BlockRows"/> stored rows. It serves the
/// <c>kind</c> filter, results.diffSeek (with a view's own running totals, <see cref="ViewBlocks"/>), and the answer's
/// overview and unit total without reading tone text. A change unit is each changed cell a tone lists (a cut tone counts
/// one more) and each added or removed row; a changed entry's units are on its new half in two rows. Soft cells are not
/// units. The one-row layout's cut rows will keep their full changed-pair lists here too (comparison plan PR 6): the
/// <see cref="Cut"/> flag already marks them.</summary>
internal sealed class DiffIndex
{
    /// <summary>Stored (or view) rows a running total covers.</summary>
    public const int BlockRows = 4096;
    /// <summary>The most buckets the answer's overview has (limits.diff.overviewBuckets).</summary>
    public const int OverviewBuckets = 512;
    /// <summary>A row's mark: its kind in the low 3 bits, then its flags.</summary>
    public const byte KindBits = 7, Dup = 8, Poss = 16, Cut = 32;
    /// <summary>Overview bucket bits: a changed entry (either half), an added row, a removed row.</summary>
    public const byte ChangedBit = 1, AddedBit = 2, RemovedBit = 4;
    /// <summary>What the index holds besides its arrays: their headers and the overview.</summary>
    public const long Overhead = 1024;
    /// <summary>Bytes a look-alike row costs: its stored row and partner kept (8), and its keys, rows and their sorted copies
    /// while the writer pairs them up (56).</summary>
    public const long PossibleBytes = 64;
    /// <summary>The most kinds a <c>kind</c> filter names (limits.diff.maxKinds).</summary>
    public const int MaxKinds = 4;

    private readonly byte[] marks;
    private readonly ushort[] units;
    private readonly long[] blocks;
    private readonly int[] possRows;
    private readonly int[] partners;
    private readonly byte[] overview;

    private DiffIndex(byte[] marks, ushort[] units, int[] possRows, int[] partners, long bytes)
    {
        this.marks = marks;
        this.units = units;
        this.possRows = possRows;
        this.partners = partners;
        Bytes = bytes;
        blocks = new long[marks.Length / BlockRows + 2];
        long total = 0;
        for (var row = 0; row < marks.Length; row++)
        {
            if (row % BlockRows == 0) blocks[row / BlockRows] = total;
            total += units[row];
        }
        blocks[(marks.Length + BlockRows - 1) / BlockRows] = total;
        blocks[^1] = total;
        Units = total;
        overview = new byte[Math.Min(OverviewBuckets, marks.Length)];
        for (var row = 0; row < marks.Length; row++)
        {
            var bit = Bit((DiffRowKind)(marks[row] & KindBits));
            if (bit != 0) overview[(int)((long)row * overview.Length / marks.Length)] |= bit;
        }
    }

    /// <summary>The bytes an index of <paramref name="rows"/> stored rows with <paramref name="possible"/> look-alike rows
    /// holds: what results.diff reserves before writing the rows, the diff refused whole when the budget has no room.</summary>
    public static long BytesFor(long rows, long possible) => 3 * rows + 8 * (rows / BlockRows + 2) + PossibleBytes * possible + Overhead;

    /// <summary>The bytes a view's running totals take (<see cref="ViewBlocks"/>), charged with the view.</summary>
    public static long ViewBlockBytes(long rows) => 8 * (rows / BlockRows + 2);

    /// <summary>The bytes the index holds, charged with its set.</summary>
    public long Bytes { get; }
    public int Rows => marks.Length;
    /// <summary>Change units over every stored row.</summary>
    public long Units { get; }

    public DiffRowKind KindOf(int row) => (DiffRowKind)(marks[row] & KindBits);
    public bool IsCut(int row) => (marks[row] & Cut) != 0;
    public bool IsRepeated(int row) => (marks[row] & Dup) != 0;
    public int UnitsOf(int row) => units[row];

    /// <summary>A look-alike row's partner as a stored row of the diff, or -1.</summary>
    public int PartnerOf(int row)
    {
        if ((marks[row] & Poss) == 0) return -1;
        var at = Array.BinarySearch(possRows, row);
        return at < 0 ? -1 : partners[at];
    }

    public static DiffKindSet SetOf(DiffRowKind kind) => kind switch
    {
        DiffRowKind.Same => DiffKindSet.Same,
        DiffRowKind.Added => DiffKindSet.Added,
        DiffRowKind.Removed => DiffKindSet.Removed,
        _ => DiffKindSet.Changed
    };

    private static byte Bit(DiffRowKind kind) => kind switch
    {
        DiffRowKind.Same => 0,
        DiffRowKind.Added => AddedBit,
        DiffRowKind.Removed => RemovedBit,
        _ => ChangedBit
    };

    public bool Keeps(int row, DiffKindSet kinds) => row < marks.Length && (SetOf(KindOf(row)) & kinds) != 0;

    /// <summary>The overview: up to <see cref="OverviewBuckets"/> even buckets of the stored rows, each the bits of the kinds
    /// in it (<see cref="ChangedBit"/>, <see cref="AddedBit"/>, <see cref="RemovedBit"/>; 0 for only unchanged rows).</summary>
    public int[] Overview() => [.. overview.Select(bits => (int)bits)];

    /// <summary>A view's running totals: the units before each <see cref="BlockRows"/> positions of its order, and the
    /// total last. One pass over the order.</summary>
    public long[] ViewBlocks(int[] order, CancellationToken token)
    {
        var totals = new long[order.Length / BlockRows + 2];
        long total = 0;
        for (var p = 0; p < order.Length; p++)
        {
            if (p % BlockRows == 0)
            {
                token.ThrowIfCancellationRequested();
                totals[p / BlockRows] = total;
            }
            var row = order[p];
            if (row < marks.Length) total += units[row];
        }
        totals[(order.Length + BlockRows - 1) / BlockRows] = total;
        totals[^1] = total;
        return totals;
    }

    /// <summary>Positions of the stored rows, or of a view's order with its running totals.</summary>
    internal readonly struct Positions(DiffIndex index, int[]? order, long[]? totals)
    {
        public int Count => order?.Length ?? index.marks.Length;
        public long Total => (totals ?? index.blocks)[^1];
        public int RowAt(int position) => order is null ? position : order[position];
        public int UnitsAt(int position)
        {
            var row = RowAt(position);
            return row < index.marks.Length ? index.units[row] : 0;
        }
        private long BlockStart(int block) => (totals ?? index.blocks)[block];
        private bool BlockEmpty(int block) => BlockStart(block + 1) == BlockStart(block);

        /// <summary>The units at positions before <paramref name="position"/>.</summary>
        public long Before(int position)
        {
            var block = position / BlockRows;
            var before = BlockStart(block);
            for (var p = block * BlockRows; p < position; p++) before += UnitsAt(p);
            return before;
        }

        /// <summary>The first position in [start, end) with units, empty blocks skipped; -1 for none.</summary>
        public int First(int start, int end)
        {
            for (var p = start; p < end;)
            {
                if (p % BlockRows == 0 && BlockEmpty(p / BlockRows)) { p += BlockRows; continue; }
                if (UnitsAt(p) > 0) return p;
                p++;
            }
            return -1;
        }

        /// <summary>The last position in [start, end) with units, empty blocks skipped; -1 for none.</summary>
        public int Last(int start, int end)
        {
            for (var p = end - 1; p >= start;)
            {
                if (p % BlockRows == BlockRows - 1 && BlockEmpty(p / BlockRows)) { p -= BlockRows; continue; }
                if (UnitsAt(p) > 0) return p;
                p--;
            }
            return -1;
        }

        /// <summary>The next (or previous) position with units after (or before) <paramref name="from"/>, wrapping round;
        /// <paramref name="from"/> itself comes last. -1 when no position has units.</summary>
        public int Seek(long from, bool forward)
        {
            var count = Count;
            if (count == 0) return -1;
            var at = (int)Math.Clamp(from, -1, count);
            if (forward)
            {
                var next = First(at + 1, count);
                return next >= 0 ? next : First(0, Math.Min(at + 1, count));
            }
            var previous = Last(0, at);
            return previous >= 0 ? previous : Last(Math.Max(at, 0), count);
        }
    }

    public Positions Over(int[]? order = null, long[]? totals = null) => new(this, order, totals);

    /// <summary>The pair index a seek lands on in a row: an added or removed row's unit, and a cut unit, land on the first
    /// column; a changed row's first (or last) listed changed cell otherwise, read from its tone.</summary>
    public static int Column(DiffRowKind kind, bool cut, string? tone, bool first)
    {
        if (kind is DiffRowKind.Added or DiffRowKind.Removed || tone is null || (cut && !first)) return 0;
        var cells = ListedCells(tone);
        if (cells.Count == 0) return 0;
        return first ? cells[0].First : cells[^1].Last;
    }

    /// <summary>The changed (not soft) cells a tone lists, as ranges of pair indexes in order; flags and soft cells skipped.</summary>
    internal static List<(int First, int Last)> ListedCells(string tone)
    {
        var cells = new List<(int, int)>();
        foreach (var token in tone.Split(' ', StringSplitOptions.RemoveEmptyEntries).Skip(1))
        {
            if (token.Length == 0 || !char.IsAsciiDigit(token[0])) continue;
            var dash = token.IndexOf('-', StringComparison.Ordinal);
            if (dash < 0 ? !int.TryParse(token, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var one) : !int.TryParse(token.AsSpan(0, dash), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out one))
                continue;
            var last = one;
            if (dash >= 0 && !int.TryParse(token.AsSpan(dash + 1), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out last)) continue;
            cells.Add((one, last));
        }
        return cells;
    }

    /// <summary>Builds an index as the writer stores rows, in order: exactly the rows it was sized for, or the diff was cut
    /// short and is refused (the index is then never built).</summary>
    internal sealed class Builder(int rows, int possible, long bytes)
    {
        private readonly byte[] marks = new byte[rows];
        private readonly ushort[] units = new ushort[rows];
        // A look-alike row's own key and its partner's: an input row and its side (row * 2, + 1 for the new input).
        private readonly long[] ownKeys = new long[possible];
        private readonly long[] partnerKeys = new long[possible];
        private readonly int[] possRows = new int[possible];
        private int count, possCount;

        public int Count => count;

        /// <summary>The key of an input row: its 0-based row and side.</summary>
        public static long Key(int row, bool isNew) => 2L * row + (isNew ? 1 : 0);

        /// <summary>Records the next stored row. A look-alike row names its own key and its partner's (<see cref="Key"/>).</summary>
        public void Add(DiffRowKind kind, bool repeated, bool cut, int rowUnits, long ownKey = -1, long partnerKey = -1)
        {
            if (count == marks.Length) throw new InvalidOperationException("The diff stored more rows than its index was sized for.");
            var mark = (byte)kind;
            if (repeated) mark |= Dup;
            if (cut) mark |= Cut;
            if (partnerKey >= 0 && possCount < ownKeys.Length)
            {
                mark |= Poss;
                ownKeys[possCount] = ownKey;
                partnerKeys[possCount] = partnerKey;
                possRows[possCount++] = count;
            }
            marks[count] = mark;
            units[count++] = (ushort)Math.Min(rowUnits, ushort.MaxValue);
        }

        /// <summary>The index, each look-alike row's partner found by its key among the rows stored; null when fewer rows
        /// were stored than it was sized for.</summary>
        public DiffIndex? Build()
        {
            if (count != marks.Length) return null;
            var keys = ownKeys[..possCount];
            var rowsByKey = possRows[..possCount];
            Array.Sort(keys, rowsByKey);
            var kept = possRows[..possCount];
            var partnerRows = new int[possCount];
            for (var k = 0; k < possCount; k++)
            {
                var at = Array.BinarySearch(keys, partnerKeys[k]);
                partnerRows[k] = at < 0 ? -1 : rowsByKey[at];
            }
            // A partner not stored (never, as added and removed rows always are) leaves its row without one.
            for (var k = 0; k < possCount; k++) if (partnerRows[k] < 0) marks[kept[k]] &= unchecked((byte)~Poss);
            var withPartner = Enumerable.Range(0, possCount).Where(k => partnerRows[k] >= 0).ToArray();
            return new DiffIndex(marks, units, [.. withPartner.Select(k => kept[k])], [.. withPartner.Select(k => partnerRows[k])], bytes);
        }
    }

    /// <summary>The kind names a <c>kind</c> filter takes, and their set.</summary>
    public static DiffKindSet KindsOf(IEnumerable<string> names)
    {
        var kinds = DiffKindSet.None;
        foreach (var name in names)
        {
            kinds |= name switch
            {
                "same" => DiffKindSet.Same,
                "changed" => DiffKindSet.Changed,
                "added" => DiffKindSet.Added,
                "removed" => DiffKindSet.Removed,
                _ => throw new RequestException("INVALID_PARAMS", "A kind filter keeps same, changed, added or removed rows.")
            };
        }
        return kinds;
    }

    /// <summary>A kind set's names, in the order same, changed, added, removed.</summary>
    public static string[] NamesOf(DiffKindSet kinds)
    {
        var names = new List<string>(4);
        if ((kinds & DiffKindSet.Same) != 0) names.Add("same");
        if ((kinds & DiffKindSet.Changed) != 0) names.Add("changed");
        if ((kinds & DiffKindSet.Added) != 0) names.Add("added");
        if ((kinds & DiffKindSet.Removed) != 0) names.Add("removed");
        return [.. names];
    }

    /// <summary>A stored row's tone text, read from its page (the caller holds a pin); null for a NULL tone.</summary>
    public static string? ToneOf(ResultSetBuffer set, int row)
    {
        var tone = set.Columns.Count - 1;
        var found = set.PagesFor(row, 1);
        if (found.Count == 0 || found[0].FirstRow > row) return null;
        var page = found[0];
        var at = (int)(row - page.FirstRow);
        var view = PageView.Parse(page.Body(), set.Wires.Count);
        return view.IsNull(tone, at) ? null : Encoding.UTF8.GetString(view.Span(tone, at));
    }
}
