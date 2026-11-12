using System.Buffers.Binary;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>results.profile: aggregates over a result's rows, or a view's (so they follow its sort now and its filter
/// later), for the column profile panel. It answers counts, a distinct count, the lowest and highest value, length
/// figures and a histogram per column, and the rows' byte sizes; never rows. Values compare as a sort does
/// (<see cref="ViewSorter"/>): NULL (and a cell that could not be read) is counted apart and never a minimum, equality
/// follows the column's collation (trailing spaces ignored), exact numerics compare at any precision. Distinct values are
/// counted exactly up to <see cref="ExactDistinct"/> and estimated past it (HyperLogLog, about 1 % off), so the work's
/// memory is bounded per column whatever the rows hold. Rows are read in base order through a bitmap of the view's rows:
/// order never changes an aggregate, and a filtered view only clears bits.</summary>
internal static class ColumnProfiler
{
    /// <summary>The most columns one request profiles (src/shared/ipc/wire/protocol.ts limits.profile.maxColumns).</summary>
    public const int MaxColumns = 32;
    /// <summary>Histogram buckets (limits.profile.bins).</summary>
    public const int Bins = 20;
    /// <summary>Distinct values counted exactly before the count becomes an estimate (limits.profile.exactDistinct).</summary>
    public const int ExactDistinct = 16_384;
    /// <summary>Characters of a lowest or highest value returned (limits.profile.valueChars); a longer one ends in "…".</summary>
    public const int ValueChars = 256;
    private const int RegisterBits = 14;
    private const int Registers = 1 << RegisterBits;
    /// <summary>Kept of a lowest or highest cell for display: enough UTF-8 for <see cref="ValueChars"/> characters.</summary>
    private const int DisplayBytes = 4 * ValueChars;

    /// <summary>What a profile holds while it runs, charged to the result's budget: the view's row bitmap, and per column
    /// an exact distinct set at its cap (about 24 bytes an entry), the estimator's registers and its two kept values.</summary>
    public static long WorkingBytes(long baseRows, int columns) => baseRows / 8 + 1024 + columns * (24L * Math.Min(baseRows, ExactDistinct) + Registers + 4 * DisplayBytes + 4096);

    /// <summary>Memory a profile takes beyond <see cref="WorkingBytes"/> as it meets large values (a lowest or highest
    /// key, a sort key's buffers), reserved from the result's budget as it grows; the caller returns <see cref="Extra"/>.
    /// A refusal ends the profile with <see cref="ProfileTooLargeException"/>.</summary>
    internal sealed class Charges(Func<long, bool> reserve)
    {
        private long extra;
        public long Extra => Interlocked.Read(ref extra);

        public void Add(long bytes)
        {
            if (bytes <= 0) return;
            if (!reserve(bytes)) throw new ProfileTooLargeException();
            Interlocked.Add(ref extra, bytes);
        }
    }

    internal sealed class ProfileTooLargeException() : Exception("The profile needs more result memory than the budget has.");

    public static ResultsProfileResult Profile(ResultSetBuffer set, StoredPage[] pages, ResultView? view, IReadOnlyList<int> columns, bool complete, CancellationToken token, Charges? charges = null)
    {
        charges ??= new Charges(_ => true);
        long baseRows = 0;
        foreach (var page in pages) baseRows += page.Rows;
        byte[]? included = null;
        if (view is not null)
        {
            included = new byte[(baseRows + 7) / 8];
            foreach (var row in view.Order) if (row < baseRows) included[row >> 3] |= (byte)(1 << (row & 7));
        }
        bool Included(long row) => included is null || (included[row >> 3] & (1 << (int)(row & 7))) != 0;
        var rows = view?.Rows ?? baseRows;
        var accumulators = columns.Select(column => new Accumulator(set, column, charges)).ToArray();
        var sizes = new LengthStats();
        var guessed = set.Lengths.Any(length => length.Estimated);
        var count = set.Wires.Count;
        // Each column's figures are its own, so each column reads the pages on its own thread, in row order; the rows'
        // sizes, from the pages' lengths alone, take one more.
        void Sizes()
        {
            foreach (var page in pages)
            {
                token.ThrowIfCancellationRequested();
                var first = page.FirstRow;
                var measured = page.Lengths.Rows == page.Rows;
                var estimated = new HashSet<int>();
                if (measured) page.Lengths.EstimatedRows(0, page.Rows, row => estimated.Add(row));
                for (var r = 0; r < page.Rows; r++)
                {
                    if (!Included(first + r)) continue;
                    if (measured) sizes.Add(page.Lengths.RowBytes(r), !guessed && !estimated.Contains(r));
                    else sizes.Add(0, false);
                }
            }
        }
        void Column(Accumulator accumulator)
        {
            var scratch = new int[PageView.ScratchLength(count)];
            foreach (var page in pages)
            {
                token.ThrowIfCancellationRequested();
                var parsed = PageView.Parse(page.Body, count, scratch);
                for (var r = 0; r < page.Rows; r++)
                    if (Included(page.FirstRow + r)) accumulator.Add(parsed, page.Lengths, r);
            }
            // The histogram's buckets span the column's range, known only now: a second pass fills them.
            if (!accumulator.NeedsBins) return;
            foreach (var page in pages)
            {
                token.ThrowIfCancellationRequested();
                var parsed = PageView.Parse(page.Body, count, scratch);
                for (var r = 0; r < page.Rows; r++)
                    if (Included(page.FirstRow + r)) accumulator.Bin(parsed, page.Lengths, r);
            }
        }
        try
        {
            Parallel.For(0, accumulators.Length + 1, new ParallelOptions { MaxDegreeOfParallelism = ViewSorter.Workers }, index =>
            {
                if (index == accumulators.Length) Sizes();
                else Column(accumulators[index]);
            });
        }
        catch (AggregateException error) when (error.InnerExceptions.Count > 0)
        {
            // What the one thread would have thrown: a cancellation, or a refusal of the room a value needed.
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerExceptions[0]).Throw();
        }
        return new ResultsProfileResult(rows, complete, sizes.Result(), [.. accumulators.Select(accumulator => accumulator.Result(rows))]);
    }

    /// <summary>What a column's histogram counts: its values (numbers), its instants (date and time types, in ticks), or its
    /// cells' characters (text) or bytes (binary).</summary>
    private enum Basis { None, Value, Time, Chars, Bytes }

    private static Basis BasisOf(ResultColumn column, WireKind wire, ViewSorter.Kind kind)
    {
        if (wire == WireKind.Binary) return Basis.Bytes;
        if (ViewSorter.IsText(column)) return Basis.Chars;
        if (kind is ViewSorter.Kind.Exact or ViewSorter.Kind.Approximate) return Basis.Value;
        return ViewSorter.TypeName(column) is "date" or "datetime" or "datetime2" or "smalldatetime" or "time" or "datetimeoffset" ? Basis.Time : Basis.None;
    }

    private sealed class LengthStats
    {
        public long Count, Min = long.MaxValue, Max = long.MinValue;
        public double Sum;
        public bool Exact = true;

        public void Add(long value, bool exact)
        {
            Count++;
            if (value < Min) Min = value;
            if (value > Max) Max = value;
            Sum += value;
            if (!exact) Exact = false;
        }

        public ProfileLengths? Result() => Count == 0 ? null : new ProfileLengths(Min, Max, Sum / Count, Exact);
    }

    /// <summary>One column's figures as the rows pass.</summary>
    private sealed class Accumulator
    {
        private readonly int column;
        private readonly ResultColumn meta;
        private readonly WireKind wire;
        private readonly ColumnLength length;
        private readonly ViewSorter.Kind kind;
        private readonly Basis basis;
        private readonly (CompareInfo Info, CompareOptions Options)? culture;
        private readonly bool trim;
        private readonly Charges charges;
        private long values;
        private bool approximate;
        private HashSet<ulong>? exact = [];
        private byte[]? registers;
        private byte[] key = new byte[64];
        private char[] chars = new char[256];
        /// <summary>The lowest and highest keys so far, in buffers reused as they change (grown, and charged, only for a
        /// longer key), and the starts of their cells for display.</summary>
        private byte[] minKey = [], maxKey = [];
        private int minLength = -1, maxLength = -1;
        private byte[]? minCell, maxCell;
        private bool minCut, maxCut;
        private readonly LengthStats? charStats, byteStats;
        private double low = double.PositiveInfinity, high = double.NegativeInfinity;
        private readonly long[] bins = new long[Bins];

        public Accumulator(ResultSetBuffer set, int column, Charges charges)
        {
            this.column = column;
            this.charges = charges;
            meta = set.Columns[column];
            wire = set.Wires[column];
            length = set.Lengths[column];
            kind = ViewSorter.KindOf(meta, wire);
            basis = BasisOf(meta, wire, kind);
            culture = kind == ViewSorter.Kind.Collated ? ViewSorter.Culture(meta.Collation) : null;
            trim = meta.Collation is not null;
            if (wire == WireKind.Binary || ViewSorter.IsText(meta))
            {
                charStats = wire == WireKind.Binary ? null : new LengthStats();
                byteStats = new LengthStats();
            }
        }

        public bool NeedsBins => basis != Basis.None && values > 0;

        public void Add(PageView view, PageLengths lengths, int row)
        {
            if (view.IsNull(column, row)) return;
            values++;
            var cell = view.Span(column, row);
            var truncated = view.IsTruncated(column, row);
            if (truncated) approximate = true;
            var normal = Normalize(cell);
            Distinct(normal);
            if (minLength < 0 || Compare(normal, minKey.AsSpan(0, minLength)) < 0) { minLength = Hold(normal, ref minKey); minCut = Keep(cell, truncated, ref minCell); }
            if (maxLength < 0 || Compare(normal, maxKey.AsSpan(0, maxLength)) > 0) { maxLength = Hold(normal, ref maxKey); maxCut = Keep(cell, truncated, ref maxCell); }
            if (byteStats is not null)
            {
                var size = Size(lengths, row, cell, truncated);
                charStats?.Add(size.Chars, size.Exact);
                byteStats.Add(size.Bytes, size.Exact);
            }
            if (basis is Basis.Value or Basis.Time && Measure(cell) is { } measure)
            {
                if (measure < low) low = measure;
                if (measure > high) high = measure;
            }
        }

        public void Bin(PageView view, PageLengths lengths, int row)
        {
            if (view.IsNull(column, row)) return;
            var cell = view.Span(column, row);
            double? measure = basis switch
            {
                Basis.Chars => Size(lengths, row, cell, view.IsTruncated(column, row)).Chars,
                Basis.Bytes => Size(lengths, row, cell, view.IsTruncated(column, row)).Bytes,
                _ => Measure(cell)
            };
            if (measure is not { } value) return;
            var (from, to) = Range();
            var bin = to <= from ? 0 : (int)Math.Min(Bins - 1, Math.Max(0, Math.Floor((value - from) / (to - from) * Bins)));
            bins[bin]++;
        }

        private (double From, double To) Range() => basis switch
        {
            Basis.Chars => (charStats!.Min, charStats.Max),
            Basis.Bytes => (byteStats!.Min, byteStats.Max),
            _ => (low, high)
        };

        public ColumnProfile Result(long rows)
        {
            var distinct = exact?.Count ?? Estimate();
            ProfileHistogram? histogram = null;
            if (NeedsBins && Range() is var (from, to) && double.IsFinite(from) && double.IsFinite(to))
                histogram = new ProfileHistogram(basis.ToString().ToLowerInvariant(), from, to, bins);
            return new ColumnProfile(column, values, rows - values, distinct, exact is not null, Show(minCell, minCut), Show(maxCell, maxCut), approximate,
                charStats?.Result(), byteStats?.Result(), histogram);
        }

        /// <summary>A cell's characters and bytes: its length entry when it has one (a truncated or recorded cell), else
        /// derived from its stored text as CellLengths does.</summary>
        private CellSize Size(PageLengths lengths, int row, ReadOnlySpan<byte> cell, bool truncated)
        {
            if (lengths.TryCell(row, column, out var entry)) return new CellSize(entry.Chars, entry.Bytes, entry.Exact && !length.Estimated);
            var size = length.Derive(cell, wire);
            return truncated || length.Rule == LengthRule.Recorded ? size with { Exact = false } : size;
        }

        /// <summary>A number's value or a date and time's ticks, for the histogram; null for text that does not parse.</summary>
        private double? Measure(ReadOnlySpan<byte> cell)
        {
            if (basis == Basis.Value)
                return double.TryParse(cell, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) ? number : null;
            Span<char> text = stackalloc char[64];
            var count = Encoding.UTF8.GetChars(cell[..Math.Min(cell.Length, 64)], text);
            var shown = text[..count];
            if (ViewSorter.TypeName(meta) == "time") return TimeSpan.TryParse(shown, CultureInfo.InvariantCulture, out var time) ? time.Ticks : null;
            if (kind == ViewSorter.Kind.Ticks) return DateTimeOffset.TryParse(shown, CultureInfo.InvariantCulture, DateTimeStyles.None, out var instant) ? instant.UtcTicks : null;
            return DateTime.TryParse(shown, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) ? date.Ticks : null;
        }

        /// <summary>The cell as a key whose equality is the column's equality and whose order (byte order; exact numerics
        /// by <see cref="ViewSorter.CompareNumericText"/>) is its sort order.</summary>
        private ReadOnlySpan<byte> Normalize(ReadOnlySpan<byte> cell)
        {
            switch (kind)
            {
                case ViewSorter.Kind.Exact: return Canonical(cell);
                case ViewSorter.Kind.Approximate:
                {
                    var number = double.TryParse(cell, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : double.NaN;
                    if (number == 0) number = 0;
                    var bits = BitConverter.DoubleToInt64Bits(number);
                    return Eight(bits >= 0 ? (ulong)bits ^ 0x8000_0000_0000_0000UL : ~(ulong)bits);
                }
                case ViewSorter.Kind.Ticks:
                {
                    Span<char> text = stackalloc char[64];
                    var count = Encoding.UTF8.GetChars(cell[..Math.Min(cell.Length, 64)], text);
                    var ticks = DateTimeOffset.TryParse(text[..count], CultureInfo.InvariantCulture, DateTimeStyles.None, out var value) ? value.UtcTicks : long.MinValue;
                    return Eight((ulong)ticks ^ 0x8000_0000_0000_0000UL);
                }
                case ViewSorter.Kind.Guid:
                {
                    Span<char> text = stackalloc char[40];
                    var count = Encoding.UTF8.GetChars(cell[..Math.Min(cell.Length, 40)], text);
                    var (high, low) = Guid.TryParse(text[..count], out var value) ? ViewSorter.GuidOrder(value) : (0UL, 0UL);
                    Grow(16);
                    BinaryPrimitives.WriteUInt64BigEndian(key, high);
                    BinaryPrimitives.WriteUInt64BigEndian(key.AsSpan(8), low);
                    return key.AsSpan(0, 16);
                }
                case ViewSorter.Kind.Collated when culture is { } compare:
                {
                    var trimmed = ViewSorter.TrimEnd(cell);
                    if (chars.Length < trimmed.Length)
                    {
                        var grown = Math.Max(trimmed.Length, 2 * chars.Length);
                        charges.Add(2L * (grown - chars.Length));
                        chars = new char[grown];
                    }
                    var text = chars.AsSpan(0, Encoding.UTF8.GetChars(trimmed, chars));
                    var size = compare.Info.GetSortKeyLength(text, compare.Options);
                    Grow(size);
                    return key.AsSpan(0, compare.Info.GetSortKey(text, key, compare.Options));
                }
                default: return trim ? ViewSorter.TrimEnd(cell) : cell;
            }
        }

        private int Compare(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b) =>
            kind == ViewSorter.Kind.Exact ? ViewSorter.CompareNumericText(a, b) : Math.Sign(a.SequenceCompareTo(b));

        private ReadOnlySpan<byte> Eight(ulong value)
        {
            BinaryPrimitives.WriteUInt64BigEndian(key, value);
            return key.AsSpan(0, 8);
        }

        private void Grow(int size)
        {
            if (key.Length >= size) return;
            var grown = Math.Max(size, 2 * key.Length);
            charges.Add(grown - key.Length);
            key = new byte[grown];
        }

        /// <summary>Copies a key into a kept buffer, growing it (and charging the growth) only for a longer key.</summary>
        private int Hold(ReadOnlySpan<byte> normal, ref byte[] kept)
        {
            if (kept.Length < normal.Length)
            {
                var grown = Math.Max(normal.Length, Math.Min(2 * kept.Length, normal.Length + 4096));
                charges.Add(grown - kept.Length);
                kept = new byte[grown];
            }
            normal.CopyTo(kept);
            return normal.Length;
        }

        /// <summary>Exact numeric text without a negative zero's sign, leading zeros or trailing fraction zeros, so equal
        /// values have equal keys ("-0.00" and "0" are both "0").</summary>
        private ReadOnlySpan<byte> Canonical(ReadOnlySpan<byte> cell)
        {
            var negative = cell.Length > 0 && cell[0] == (byte)'-';
            if (negative) cell = cell[1..];
            var point = cell.IndexOf((byte)'.');
            var whole = (point < 0 ? cell : cell[..point]).TrimStart((byte)'0');
            var fraction = (point < 0 ? [] : cell[(point + 1)..]).TrimEnd((byte)'0');
            if (whole.IsEmpty && fraction.IsEmpty) { key[0] = (byte)'0'; return key.AsSpan(0, 1); }
            Grow(whole.Length + fraction.Length + 3);
            var at = 0;
            if (negative) key[at++] = (byte)'-';
            if (whole.IsEmpty) key[at++] = (byte)'0';
            whole.CopyTo(key.AsSpan(at));
            at += whole.Length;
            if (!fraction.IsEmpty)
            {
                key[at++] = (byte)'.';
                fraction.CopyTo(key.AsSpan(at));
                at += fraction.Length;
            }
            return key.AsSpan(0, at);
        }

        private void Distinct(ReadOnlySpan<byte> normal)
        {
            var hash = Hash(normal);
            if (exact is not null)
            {
                if (exact.Add(hash) && exact.Count > ExactDistinct)
                {
                    registers = new byte[Registers];
                    foreach (var seen in exact) Register(seen);
                    exact = null;
                }
                return;
            }
            Register(hash);
        }

        private void Register(ulong hash)
        {
            var index = (int)(hash >> (64 - RegisterBits));
            var rank = (byte)(BitOperations.LeadingZeroCount((hash << RegisterBits) | (1UL << (RegisterBits - 1))) + 1);
            if (rank > registers![index]) registers[index] = rank;
        }

        /// <summary>HyperLogLog's estimate, with linear counting while registers are still empty; never more than the
        /// values seen nor fewer than the exact count it outgrew.</summary>
        private long Estimate()
        {
            double sum = 0;
            var zeros = 0;
            foreach (var rank in registers!)
            {
                sum += Math.Pow(2, -rank);
                if (rank == 0) zeros++;
            }
            const double m = Registers;
            var estimate = 0.7213 / (1 + 1.079 / m) * m * m / sum;
            if (estimate <= 2.5 * m && zeros > 0) estimate = m * Math.Log(m / zeros);
            return Math.Min(values, Math.Max(ExactDistinct + 1, (long)Math.Round(estimate)));
        }

        /// <summary>Copies the start of a lowest or highest cell for display; true when the copy, or the stored cell, is cut.</summary>
        private bool Keep(ReadOnlySpan<byte> cell, bool truncated, ref byte[]? kept)
        {
            var limit = wire == WireKind.Binary ? ValueChars / 2 - 1 : DisplayBytes;
            var take = Math.Min(cell.Length, limit);
            if (kept is null || kept.Length != take) kept = new byte[take];
            cell[..take].CopyTo(kept);
            return truncated || take < cell.Length;
        }

        /// <summary>A kept cell as text: binary as 0x and hex digits, text cut to <see cref="ValueChars"/> characters.</summary>
        private string? Show(byte[]? kept, bool cut)
        {
            if (kept is null) return null;
            string text;
            if (wire == WireKind.Binary) text = "0x" + Convert.ToHexString(kept);
            else
            {
                text = Encoding.UTF8.GetString(kept);
                // A copy cut inside a UTF-8 sequence decodes its last character as U+FFFD.
                if (cut && text.EndsWith('�')) text = text[..^1];
            }
            if (text.Length > ValueChars)
            {
                var end = char.IsHighSurrogate(text[ValueChars - 1]) ? ValueChars - 1 : ValueChars;
                text = text[..end];
                cut = true;
            }
            return cut ? text + "…" : text;
        }
    }

    /// <summary>FNV-1a over the key, then MurmurHash3's finalizer, which spreads its bits for the estimator.</summary>
    internal static ulong Hash(ReadOnlySpan<byte> bytes)
    {
        var hash = 14695981039346656037UL;
        foreach (var b in bytes) hash = (hash ^ b) * 1099511628211UL;
        hash ^= hash >> 33;
        hash *= 0xff51afd7ed558ccdUL;
        hash ^= hash >> 33;
        hash *= 0xc4ceb9fe1a85ec53UL;
        hash ^= hash >> 33;
        return hash;
    }
}
