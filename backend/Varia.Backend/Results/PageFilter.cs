using System.Buffers;
using System.Numerics;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>A packed page's n-gram filter, built when the page is packed (<see cref="ResultSetBuffer.Pack"/>) and kept with
/// it (<see cref="PackedPage"/>): per column, the ASCII characters its cells hold (and whether any other) and a Bloom
/// filter of their n-grams (two bits a gram). Find (<see cref="ResultSearcher"/>) passes over a page every searched column
/// of which says the text cannot be there, without unpacking or matching it. A column says so only through the space its
/// matcher compares in, so a cell that holds the text holds every character and gram of the text there: the code units
/// themselves (a binary collation), each one's ordinal-ignore-case class (no collation, and binary columns' hex), or the
/// culture's fold (<see cref="SearchFold"/>, whose pre-check is sound). A column with a cell the fold cannot vouch for, a
/// culture without a verified fold, and a page whose filter would be too full say "maybe".</summary>
internal sealed class PageFilter
{
    /// <summary>Texts shorter than this are searched without the filters: their few grams rule out almost no page.</summary>
    internal const int MinText = 4;
    /// <summary>Pages smaller than this get no filter: reading them costs little, and their filter would be a large share of
    /// them (<see cref="ResultStore.FilterMinBytes"/>; the checks lower it to filter small pages).</summary>
    internal const int MinPageBytes = 32 * 1024;
    /// <summary>A column's filter while it is built: 16 KiB, halved while it stays at most <see cref="MaxFill"/> full.</summary>
    private const int BuildWords = 2048;
    private const int MinWords = 8;
    /// <summary>A column's grams held before its filter is sized: past this many a filter of two bits a gram at most
    /// <see cref="MaxFill"/> full needs all of <see cref="BuildWords"/>, so they go straight into it.</summary>
    internal const int HeldGrams = (int)(BuildWords * 64 * MaxFill / 2);
    /// <summary>The share of bits set past which a column keeps no gram filter (a gram then passes half the time or more).</summary>
    private const double MaxFill = 0.4;
    private const char Surrogate = '\uD800';

    internal enum Space : byte { Ordinal, IgnoreCase, Fold, Hex }

    private sealed class Column(Space space, SearchFold? fold, int n, ulong ascii0, ulong ascii1, bool other, bool truncated, ulong[]? bits)
    {
        /// <summary>A column with no value on the page: no text can be there, whatever the compare.</summary>
        public static readonly Column Empty = new(Space.Ordinal, null, 3, 0, 0, false, false, null);
        public Space Space => space;
        public SearchFold? Fold => fold;
        public int N => n;
        public bool Truncated => truncated;
        public ulong[]? Bits => bits;
        public Column WithoutGrams() => new(space, fold, n, ascii0, ascii1, other, truncated, null);
        public bool SameAs(Column column) => space == column.Space && fold == column.Fold && n == column.N && truncated == column.Truncated
            && Characters == column.Characters && (bits is null ? column.Bits is null : column.Bits is not null && bits.AsSpan().SequenceEqual(column.Bits));
        private (ulong, ulong, bool) Characters => (ascii0, ascii1, other);

        /// <summary>Whether no cell of the column can hold <paramref name="text"/>, already in the column's space.</summary>
        public bool Excludes(string text)
        {
            foreach (var c in text)
            {
                if (c < 64) { if ((ascii0 & (1UL << c)) == 0) return true; }
                else if (c < 128) { if ((ascii1 & (1UL << (c - 64))) == 0) return true; }
                else if (!other) return true;
            }
            if (bits is null || text.Length < n) return false;
            var mask = (uint)bits.Length * 64 - 1;
            for (var i = 0; i + n <= text.Length; i++)
                if (!Has(bits, mask, Gram(text.AsSpan(i, n)))) return true;
            return false;
        }
    }

    private readonly Column?[] columns;

    private PageFilter(Column?[] columns, long bytes)
    {
        this.columns = columns;
        Bytes = bytes;
    }

    /// <summary>What the filter holds, charged to the result's budget with its packed page.</summary>
    public long Bytes { get; }

    /// <summary>The space a column's cells are compared in for Find (<see cref="ResultSearcher.MatcherFor"/>), and its fold;
    /// null when it is never searched (hidden) or has no verified fold yet.</summary>
    internal static Space? SpaceOf(ResultColumn column, WireKind wire, out SearchFold? fold)
    {
        fold = null;
        if (ResultTextWriter.Hidden(column)) return null;
        if (wire == WireKind.Binary) return Space.Hex;
        if (column.Collation is not { } collation) return Space.IgnoreCase;
        if ((collation.Options & (16384 | 32768)) != 0) return Space.Ordinal;
        if (ViewSorter.Culture(collation) is { } culture)
        {
            // Waits for the fold's first build (0.05 - 0.1 s, once a culture and options): a page packed without it would
            // keep no filter for the column as long as it stays packed.
            fold = SearchFold.Awaited(collation.Lcid, culture.Options);
            return fold is null ? null : Space.Fold;
        }
        return (collation.Options & 1) != 0 ? Space.IgnoreCase : Space.Ordinal;
    }

    /// <summary>Builds the filter of a raw page, at most <paramref name="maxBytes"/> (the largest gram filters left out
    /// first), or null when no column could have one or even the columns' characters would take more. Each column's gram
    /// filter is built at the size it would halve to from <see cref="BuildWords"/> (<paramref name="sized"/> false builds it
    /// that way, for the checks), so a column of short cells costs its cells, not 16 KiB.</summary>
    public static PageFilter? Build(ReadOnlySpan<byte> page, IReadOnlyList<ResultColumn> resultColumns, IReadOnlyList<WireKind> wires, long maxBytes = long.MaxValue, bool sized = true)
    {
        var held = ArrayPool<ulong>.Shared.Rent(HeldGrams);
        try { return Build(page, resultColumns, wires, maxBytes, sized, held); }
        finally { ArrayPool<ulong>.Shared.Return(held); }
    }

    /// <summary><see cref="Build(ReadOnlySpan{byte}, IReadOnlyList{ResultColumn}, IReadOnlyList{WireKind}, long, bool)"/>
    /// holding grams in <paramref name="held"/> (at least <see cref="HeldGrams"/> long), which it leaves cleared: grams are
    /// invertible, so a pooled array would keep pieces of cell text past the result's release.</summary>
    internal static PageFilter? Build(ReadOnlySpan<byte> page, IReadOnlyList<ResultColumn> resultColumns, IReadOnlyList<WireKind> wires, long maxBytes, bool sized, ulong[] held)
    {
        try { return Columns(page, resultColumns, wires, maxBytes, sized, held); }
        finally { Array.Clear(held, 0, HeldGrams); }
    }

    private static PageFilter? Columns(ReadOnlySpan<byte> page, IReadOnlyList<ResultColumn> resultColumns, IReadOnlyList<WireKind> wires, long maxBytes, bool sized, ulong[] held)
    {
        var count = wires.Count;
        var view = PageView.Parse(page, count);
        var built = new Column?[count];
        var scratch = new ulong[BuildWords];
        var chars = new char[256];
        var folded = new char[256];
        long bytes = 64 + 8L * count;
        // What no filter of the page can go below: its header and each built column's characters (gram filters can be left
        // out). Past the cap, there is no filter, so no cell is read and no fold awaited for one.
        var floor = bytes;
        if (floor > maxBytes) return null;
        var any = false;
        for (var c = 0; c < count; c++)
        {
            if (ResultTextWriter.Hidden(resultColumns[c])) continue;
            if (view.Rows > 0 && view.NullCount(c, 0, view.Rows - 1) == view.Rows)
            {
                built[c] = Column.Empty;
                any = true;
                continue;
            }
            if (SpaceOf(resultColumns[c], wires[c], out var fold) is not { } space) continue;
            // GUIDs and binary hold every hex trigram: their grams are four characters.
            var n = space == Space.Hex || resultColumns[c].DataType == "uniqueidentifier" ? 4 : 3;
            // Grams are held until the column ends, to size its filter, unless they would need all of it anyway.
            var grams = 0;
            var direct = !sized;
            if (direct) Array.Clear(scratch);
            ulong ascii0 = 0, ascii1 = 0;
            bool other = false, truncated = false, vouched = true;
            for (var row = 0; row < view.Rows && vouched; row++)
            {
                if (view.IsNull(c, row)) continue;
                truncated |= view.IsTruncated(c, row);
                var cell = view.Span(c, row);
                ReadOnlySpan<char> text;
                if (space == Space.Hex)
                {
                    // Hex may grow chars: take the span after it returns.
                    var length = Hex(cell, ref chars);
                    text = chars.AsSpan(0, length);
                }
                else
                {
                    if (chars.Length < cell.Length) chars = new char[Math.Max(cell.Length, 2 * chars.Length)];
                    text = chars.AsSpan(0, Encoding.UTF8.GetChars(cell, chars));
                }
                if (space == Space.Fold)
                {
                    if (!fold!.TryFold(text, ref folded, out var length)) { vouched = false; break; }
                    text = folded.AsSpan(0, length);
                }
                else if (space != Space.Ordinal)
                {
                    var span = chars.AsSpan(0, text.Length);
                    IgnoreCase(text, span);
                    text = span;
                }
                foreach (var ch in text)
                {
                    if (ch < 64) ascii0 |= 1UL << ch;
                    else if (ch < 128) ascii1 |= 1UL << (ch - 64);
                    else other = true;
                }
                for (var i = 0; i + n <= text.Length; i++)
                {
                    var gram = Gram(text.Slice(i, n));
                    if (!direct)
                    {
                        if (grams < HeldGrams) { held[grams++] = gram; continue; }
                        Array.Clear(scratch);
                        for (var k = 0; k < grams; k++) Set(scratch, BuildWords * 64 - 1, held[k]);
                        direct = true;
                    }
                    Set(scratch, BuildWords * 64 - 1, gram);
                }
            }
            CellsRead += view.Rows;
            if (!vouched) continue;
            var words = BuildWords;
            if (!direct)
            {
                // The smallest size two bits a gram leave at most MaxFill full: every larger size folds to it no fuller, so
                // halving from BuildWords would reach it, and folding is building smaller.
                words = MinWords;
                while (words < BuildWords && words * 64 * MaxFill < 2.0 * grams) words *= 2;
                Array.Clear(scratch, 0, words);
                for (var k = 0; k < grams; k++) Set(scratch, (uint)words * 64 - 1, held[k]);
            }
            var bits = Shrink(scratch, words);
            built[c] = new Column(space, fold, n, ascii0, ascii1, other, truncated, bits);
            bytes += ColumnBytes + (bits is null ? 0 : GramBytes(bits));
            floor += ColumnBytes;
            if (floor > maxBytes) return null;
            any = true;
        }
        if (!any) return null;
        // Over the cap: leave out the largest gram filters until it fits (a column keeps its characters).
        while (bytes > maxBytes)
        {
            var largest = -1;
            for (var c = 0; c < count; c++)
                if (built[c]?.Bits is { } bits && (largest < 0 || bits.Length > built[largest]!.Bits!.Length)) largest = c;
            if (largest < 0) return null;
            bytes -= GramBytes(built[largest]!.Bits!);
            built[largest] = built[largest]!.WithoutGrams();
        }
        return new PageFilter(built, bytes);
    }

    private const int ColumnBytes = 72;

    /// <summary>Rows of the columns the calling thread's builds have read, for the checks.</summary>
    [ThreadStatic] internal static long CellsRead;
    private static long GramBytes(ulong[] bits) => 24 + 8L * bits.Length;

    /// <summary>Whether two filters hold the same, for the checks.</summary>
    internal bool SameAs(PageFilter other) => Bytes == other.Bytes && columns.Length == other.columns.Length
        && columns.Zip(other.columns).All(pair => pair.First is null ? pair.Second is null : pair.Second is not null && pair.First.SameAs(pair.Second));

    /// <summary>The scratch filter halved (each half's bits joined) while it stays at most <see cref="MaxFill"/> full, or
    /// null when it is fuller than that already.</summary>
    private static ulong[]? Shrink(ulong[] scratch, int words)
    {
        long set = 0;
        foreach (var word in scratch.AsSpan(0, words)) set += BitOperations.PopCount(word);
        if (set > MaxFill * words * 64) return null;
        while (words > MinWords)
        {
            var half = words / 2;
            long joined = 0;
            for (var i = 0; i < half; i++) joined += BitOperations.PopCount(scratch[i] | scratch[i + half]);
            if (joined > MaxFill * half * 64) break;
            for (var i = 0; i < half; i++) scratch[i] |= scratch[i + half];
            words = half;
        }
        return scratch[..words];
    }

    /// <summary>A search's text in each column's space, for <see cref="Excludes"/>: null where the column's filter cannot
    /// judge it (no matcher, or a matcher that compares otherwise than the column was filtered, as ignorable text searched
    /// by code point in a culture column does).</summary>
    internal sealed class Query
    {
        private readonly string?[] texts;
        private readonly Space[] spaces;
        private readonly SearchFold?[] folds;
        private readonly bool[] searched;

        public Query(ResultSearcher.Matcher?[] matchers, string text)
        {
            texts = new string?[matchers.Length];
            spaces = new Space[matchers.Length];
            folds = new SearchFold?[matchers.Length];
            searched = new bool[matchers.Length];
            for (var c = 0; c < matchers.Length; c++)
            {
                if (matchers[c] is not { } matcher) continue;
                searched[c] = true;
                switch (matcher.Kind)
                {
                    case SearchNarrowing.Kind.Ordinal: spaces[c] = Space.Ordinal; texts[c] = text; break;
                    case SearchNarrowing.Kind.OrdinalIgnoreCase or SearchNarrowing.Kind.Hex:
                        spaces[c] = matcher.Kind == SearchNarrowing.Kind.Hex ? Space.Hex : Space.IgnoreCase;
                        var upper = new char[text.Length];
                        IgnoreCase(text, upper);
                        texts[c] = new string(upper);
                        break;
                    case SearchNarrowing.Kind.Culture when matcher is ResultSearcher.CultureMatcher { Folded: { } fold, Fold: { } table }:
                        spaces[c] = Space.Fold; folds[c] = table; texts[c] = fold; break;
                }
            }
        }

        /// <summary>Whether no searched column of the page can hold the text, and so whether a truncated cell of one makes the
        /// answer approximate.</summary>
        public bool Excludes(PageFilter filter, out bool truncated)
        {
            truncated = false;
            for (var c = 0; c < searched.Length; c++)
            {
                if (!searched[c]) continue;
                if (c < filter.columns.Length && filter.columns[c] == Column.Empty) continue;
                if (c >= filter.columns.Length || filter.columns[c] is not { } column || texts[c] is not { } text
                    || column.Space != spaces[c] || column.Fold != folds[c] || !column.Excludes(text)) return false;
                truncated |= column.Truncated;
            }
            return true;
        }
    }

    private static int Hex(ReadOnlySpan<byte> bytes, ref char[] chars)
    {
        var length = 2 + 2 * bytes.Length;
        if (chars.Length < length) chars = new char[Math.Max(length, 2 * chars.Length)];
        chars[0] = '0';
        chars[1] = 'x';
        for (var i = 0; i < bytes.Length; i++)
        {
            chars[2 + 2 * i] = "0123456789ABCDEF"[bytes[i] >> 4];
            chars[3 + 2 * i] = "0123456789ABCDEF"[bytes[i] & 15];
        }
        return length;
    }

    /// <summary>Each code unit's ordinal-ignore-case class: the lowest code unit .NET's OrdinalIgnoreCase finds equal to it,
    /// found from .NET itself (code units grouped by their ignore-case hash, then compared), so the filter follows the
    /// matcher exactly. Surrogates are one class: a pair matches only a pair.</summary>
    private static readonly Lazy<char[]> classes = new(() =>
    {
        var table = new char[65536];
        var groups = new Dictionary<int, List<char>>();
        for (var c = 0; c < 65536; c++)
        {
            if (char.IsSurrogate((char)c)) { table[c] = Surrogate; continue; }
            var hash = string.GetHashCode(((char)c).ToString().AsSpan(), StringComparison.OrdinalIgnoreCase);
            if (!groups.TryGetValue(hash, out var group)) groups[hash] = group = [];
            group.Add((char)c);
        }
        foreach (var group in groups.Values)
            foreach (var c in group)
            {
                var lowest = c;
                foreach (var other in group)
                    if (other < lowest && string.Equals(c.ToString(), other.ToString(), StringComparison.OrdinalIgnoreCase)) lowest = other;
                table[c] = lowest;
            }
        return table;
    });

    internal static void IgnoreCase(ReadOnlySpan<char> text, Span<char> into)
    {
        var table = classes.Value;
        for (var i = 0; i < text.Length; i++) into[i] = table[text[i]];
    }

    /// <summary>A gram of three or four code units, packed exactly into 64 bits and mixed.</summary>
    private static ulong Gram(ReadOnlySpan<char> gram)
    {
        ulong v = 0;
        foreach (var c in gram) v = (v << 16) | c;
        v ^= (ulong)gram.Length << 62;
        v *= 0x9E3779B97F4A7C15;
        return v ^ (v >> 31);
    }

    private static void Set(ulong[] bits, uint mask, ulong gram)
    {
        uint h1 = (uint)gram, h2 = (uint)(gram >> 32) | 1;
        var a = h1 & mask;
        var b = (h1 + h2) & mask;
        bits[a >> 6] |= 1UL << (int)(a & 63);
        bits[b >> 6] |= 1UL << (int)(b & 63);
    }

    private static bool Has(ulong[] bits, uint mask, ulong gram)
    {
        uint h1 = (uint)gram, h2 = (uint)(gram >> 32) | 1;
        var a = h1 & mask;
        var b = (h1 + h2) & mask;
        return (bits[a >> 6] & (1UL << (int)(a & 63))) != 0 && (bits[b >> 6] & (1UL << (int)(b & 63))) != 0;
    }
}
