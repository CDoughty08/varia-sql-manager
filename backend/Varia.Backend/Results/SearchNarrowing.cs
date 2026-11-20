using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>
/// When a search may read only the rows (or distinct values) an earlier search kept, as Find and the column filter's value
/// search do while the user types. "Whatever holds <c>abcd</c> also held <c>abc</c>" is true of an ordinal compare, but not
/// of a linguistic one: combining marks, expansions (ß, ﬁ, æ), Hangul jamo, ignorable characters and contractions (Czech
/// ch, Danish aa) all break it. So a search narrows from an earlier text to a new one only when:
/// <list type="bullet">
/// <item>the new text holds the earlier one as an ordinal substring, and the earlier one has no surrogate (a code point
/// split between the two texts is not a substring of either compare);</item>
/// <item>every column compares both texts the same way (<see cref="Kind"/>): an earlier text of only ignorable characters
/// was searched ordinally, so a culture search never narrows from it;</item>
/// <item>where a column compares by culture, the texts meet what the rules that ruled its cells out need
/// (<see cref="Needs"/>).</item>
/// </list>
/// A row is then passed over only when none of its cells matched and every cell was ruled out, by one of two rules:
/// <list type="bullet">
/// <item>the pre-check (<see cref="SearchFold"/>): the cell's fold lacked the text's fold. The pre-check is sound (a cell that
/// holds a text holds its fold, checked by SearchFoldChecks), so a cell is ruled out for any text whose fold holds the
/// earlier text's fold; it needs that of a later text (<see cref="Needs.Fold"/>).</item>
/// <item>ASCII: the cell and the text are pure ASCII and the culture joins no two ASCII characters into one
/// (<see cref="SafeCulture"/>), so a longer ASCII text is not in the cell either; it needs a later text to be ASCII too
/// (<see cref="Needs.Ascii"/>). Used where the culture has no fold, or the pre-check stopped (most cells passed it).</item>
/// </list>
/// Any other cell that did not match (a cell the fold cannot vouch for that is not ASCII, any cell of a culture that
/// joins ASCII letters) is searched again. So a result with one Czech column still narrows on its other columns' rows.
/// Ordinal and binary (hex) columns narrow freely. The same text searched again reads only the earlier matches, in every
/// culture: a compare's answer for one cell and one text never changes.
/// </summary>
internal static class SearchNarrowing
{
    /// <summary>How a column compares a search text: no cell can match (a hidden column, or a binary one and text that is not
    /// hex), ordinally, ordinally ignoring case, on binary values' hex, or by culture.</summary>
    internal enum Kind : byte { None, Ordinal, OrdinalIgnoreCase, Hex, Culture }

    /// <summary>What a later text must meet to narrow from a culture column's cells an earlier search ruled out: its fold
    /// must hold the earlier text's fold (cells ruled out by the pre-check), and it must be ASCII as the earlier one was
    /// (cells ruled out as ASCII).</summary>
    [Flags]
    internal enum Needs : byte { None = 0, Fold = 1, Ascii = 2 }

    /// <summary>The cultures (LCIDs) never narrowed, whatever <see cref="Probe"/> finds: Danish, Norwegian (Bokmål and
    /// Nynorsk), Hungarian and Croatian join letters into one, and Thai's compare does not follow its sort keys
    /// (<see cref="SearchFold.Verified"/> leaves all of them out).</summary>
    internal static readonly int[] Excluded = [1030, 1044, 2068, 1038, 1050, 1054];

    private static readonly ConcurrentDictionary<(string Name, CompareOptions Options), bool> safe = new();

    /// <summary>Whether a culture compare under these options may narrow pure-ASCII text over pure-ASCII cells: the culture
    /// is not <see cref="Excluded"/> and <see cref="Probe"/> finds no pair of ASCII characters it joins. Probed once per
    /// culture and option set (about 15 ms), then kept for the process.</summary>
    public static bool SafeCulture(CompareInfo info, CompareOptions options) =>
        Array.IndexOf(Excluded, info.LCID) < 0 && safe.GetOrAdd((info.Name, options), _ => Probe(info, options));

    /// <summary>Whether every two-character ASCII string holds each of its characters under the compare. A culture that
    /// treats a pair as one letter (Czech and Slovak ch, Albanian dh, Welsh ll, Hungarian cs) does not find c in ch, so
    /// typing c then ch must search again. Triples were probed too, over every letter and digit, in every culture .NET
    /// knows that SQL Server collates: none failed that no pair failed.</summary>
    internal static bool Probe(CompareInfo info, CompareOptions options)
    {
        Span<char> pair = stackalloc char[2];
        for (var x = 0; x < 128; x++)
            for (var y = 0; y < 128; y++)
            {
                pair[0] = (char)x;
                pair[1] = (char)y;
                if (info.IndexOf(pair, pair[..1], options) < 0 || info.IndexOf(pair, pair[1..], options) < 0) return false;
            }
        return true;
    }

    /// <summary>Whether a search for <paramref name="next"/> may read only what the search for <paramref name="previous"/>
    /// kept (its matches and rechecks), given each column's <see cref="Kind"/> for both texts, what the earlier search's
    /// ruling out needs (<see cref="Needs"/>), and both texts' folds. Not for the same text, which reads only the matches.</summary>
    public static bool Extends(string previous, ReadOnlySpan<Kind> previousKinds, ReadOnlySpan<Needs> needs, ReadOnlySpan<string?> previousFolds, string next, ReadOnlySpan<Kind> nextKinds, ReadOnlySpan<string?> nextFolds, bool elsewhere = false)
    {
        if (previousKinds.Length != nextKinds.Length || !next.Contains(previous, StringComparison.Ordinal)) return false;
        foreach (var c in previous) if (char.IsSurrogate(c)) return false;
        for (var i = 0; i < nextKinds.Length; i++)
        {
            // A column where no cell can hold the new text has nothing to search again.
            // A column the earlier text searched but the next cannot match (hex text grown a non-hex letter): when truncated
            // cells left the earlier search approximate, they may be this column's, which a full search of the next text skips.
            if (nextKinds[i] == Kind.None) { if (elsewhere && previousKinds[i] != Kind.None) return false; continue; }
            if (nextKinds[i] != previousKinds[i]) return false;
            if ((needs[i] & Needs.Ascii) != 0 && !(Ascii.IsValid(previous) && Ascii.IsValid(next))) return false;
            if ((needs[i] & Needs.Fold) != 0 && (previousFolds[i] is not { } earlier || nextFolds[i]?.Contains(earlier, StringComparison.Ordinal) != true)) return false;
        }
        return true;
    }
}

/// <summary>What a result's last search kept for the next (<see cref="ResultSetBuffer.SearchMemo"/>): its text, the view it
/// read (0 for base order), the positions it covered (a view's rows, or the rows sealed then), each column's compare, and
/// two bits a position: the rows that matched, and the rows that did not but hold a cell a narrowed search must look at
/// again (<see cref="SearchNarrowing.Recheck"/>). <c>Approximate</c> is the search's own; <c>Elsewhere</c> whether a
/// truncated cell did not match in a row with neither bit, which a narrowed search never reads but whose answer it must
/// still report. Never changed once kept; charged to the result's budget as spare memory (<see cref="Bytes"/>).</summary>
internal sealed class SearchMemo(string text, uint viewId, long rows, SearchNarrowing.Kind[] kinds, SearchNarrowing.Needs[] needs, string?[] folds, ulong[] matched, ulong[] recheck, bool approximate, bool elsewhere, long bytes)
{
    public string Text { get; } = text;
    public uint ViewId { get; } = viewId;
    public long Rows { get; } = rows;
    public SearchNarrowing.Kind[] Kinds { get; } = kinds;
    /// <summary>What a later text must meet, per column, to narrow from the rows this memo rules out.</summary>
    public SearchNarrowing.Needs[] Needs { get; } = needs;
    /// <summary>Each pre-checking column's fold of the text (<see cref="ResultSearcher.CultureMatcher.Folded"/>).</summary>
    public string?[] Folds { get; } = folds;
    public ulong[] Matched { get; } = matched;
    public ulong[] Recheck { get; } = recheck;
    public bool Approximate { get; } = approximate;
    public bool Elsewhere { get; } = elsewhere;
    public long Bytes { get; } = bytes;

    /// <summary>What a memo of <paramref name="rows"/> positions costs: two bits a position, its text, its columns' folds
    /// (<paramref name="foldLength"/> characters in all: a fold can be longer than its text) and its bookkeeping.</summary>
    public static long BytesFor(long rows, int columns, int textLength, long foldLength) => 16 * ((rows + 63) / 64) + columns * 9L + 2L * foldLength + 2L * textLength + 256;
}

/// <summary>One search's use of the result's last search (<see cref="SearchMemo"/>): which positions it may pass over
/// (<see cref="Skip"/>: with the same text, every row that did not match; with a text that extends the last one under
/// <see cref="SearchNarrowing.Extends"/>, every row that neither matched nor needs a recheck; positions past the memo's are
/// always read), and the memo it builds for the next search (<see cref="Mark"/>), from room reserved as spare before it
/// starts (none, and nothing kept, when there is no room). Written by the search's threads (<see cref="Mark"/> sets bits
/// atomically), finished on one.</summary>
internal sealed class Narrowing
{
    private readonly string text;
    private readonly uint viewId;
    private readonly long rows, covered, reserved;
    private readonly SearchNarrowing.Kind[] kinds;
    private readonly string?[] folds;
    private readonly ResultSearcher.Matcher?[] matchers;
    private readonly SearchMemo? from;
    private readonly bool approximate;
    // Read: the last search's matches and (extending) rechecks. Kept: this search's.
    private readonly ulong[]? matched, recheck, keepMatched, keepRecheck;
    private bool kept;

    /// <summary>Whether visited rows record their rechecks: this search keeps a memo.</summary>
    public bool Rechecks { get; }
    /// <summary>Whether a truncated cell did not match in a row this search leaves with neither bit (set by the search as
    /// its parts finish, and from the last memo for the rows it passes over).</summary>
    public bool Elsewhere { get; set; }
    /// <summary>How this search used the last one: null read every row, false narrowed from a shorter text, true repeated it.</summary>
    public bool? Repeated { get; }

    private Narrowing(string text, uint viewId, long rows, SearchNarrowing.Kind[] kinds, string?[] folds, ResultSearcher.Matcher?[] matchers, SearchMemo? from, bool repeated, long reserved)
    {
        this.text = text;
        this.viewId = viewId;
        this.rows = rows;
        this.kinds = kinds;
        this.folds = folds;
        this.matchers = matchers;
        this.from = from;
        this.reserved = reserved;
        Rechecks = reserved > 0;
        if (from is not null)
        {
            Repeated = repeated;
            covered = from.Rows;
            matched = from.Matched;
            recheck = repeated ? null : from.Recheck;
            approximate = repeated ? from.Approximate : from.Elsewhere;
            Elsewhere = from.Elsewhere;
        }
        if (reserved == 0) return;
        var words = (rows + 63) / 64;
        keepMatched = new ulong[words];
        keepRecheck = new ulong[words];
        // Repeating a text: the rows it passes over keep their bits; the ones it reads set the same again.
        if (from is not null && repeated)
        {
            Array.Copy(from.Matched, keepMatched, from.Matched.Length);
            Array.Copy(from.Recheck, keepRecheck, from.Recheck.Length);
        }
    }

    /// <summary>The plan for a search of <paramref name="text"/> over <paramref name="rows"/> positions of
    /// <paramref name="view"/> (base order when null), or null when it can neither narrow nor keep a memo.</summary>
    public static Narrowing? Plan(ResultSetBuffer set, ResultView? view, string text, ResultSearcher.Matcher?[] matchers, long rows)
    {
        var kinds = new SearchNarrowing.Kind[matchers.Length];
        var folds = new string?[matchers.Length];
        for (var c = 0; c < matchers.Length; c++)
        {
            kinds[c] = matchers[c]?.Kind ?? SearchNarrowing.Kind.None;
            folds[c] = (matchers[c] as ResultSearcher.CultureMatcher)?.Folded;
        }
        var viewId = view?.ViewId ?? 0;
        SearchMemo? from = null;
        var repeated = false;
        // The memo is the same view's (ids are never reused) over no more positions than this search reads: base order only
        // grows, and a view never changes.
        if (set.SearchMemo is { } memo && memo.ViewId == viewId && memo.Rows <= rows)
        {
            if (memo.Text == text && memo.Kinds.AsSpan().SequenceEqual(kinds)) { from = memo; repeated = true; }
            else if (SearchNarrowing.Extends(memo.Text, memo.Kinds, memo.Needs, memo.Folds, text, kinds, folds, memo.Elsewhere)) from = memo;
        }
        long foldLength = 0;
        foreach (var fold in folds) foldLength += fold?.Length ?? 0;
        var bytes = SearchMemo.BytesFor(rows, matchers.Length, text.Length, foldLength);
        var reserved = rows > 0 && set.TryReserveSpare(bytes) ? bytes : 0;
        if (from is null && reserved == 0) return null;
        // Narrowing, most rows read pass the pre-check: it keeps running, as its answer is what rules rows out.
        if (from is not null) foreach (var matcher in matchers) if (matcher is ResultSearcher.CultureMatcher culture) culture.KeepPrechecking = true;
        try { return new Narrowing(text, viewId, rows, kinds, folds, matchers, from, repeated, reserved); }
        catch
        {
            // The plan never reached the search's finally, so its room goes back here.
            if (reserved > 0) set.ReturnWork(reserved);
            throw;
        }
    }

    /// <summary>How many positions from <paramref name="position"/> on the search may pass over (0 when it must read it):
    /// up to the next one the last search kept, the end of its word, or the end of the positions the memo covers.</summary>
    public long Skip(long position)
    {
        if (matched is null || position >= covered) return 0;
        var index = (int)(position >> 6);
        var word = (matched[index] | (recheck?[index] ?? 0)) >> (int)(position & 63);
        if ((word & 1) != 0) return 0;
        var skip = Math.Min(word == 0 ? 64 - (position & 63) : BitOperations.TrailingZeroCount(word), covered - position);
        return skip;
    }

    /// <summary>How many positions the search passed over, summed from its runs once they end (the checks: narrowing
    /// did skip rows); a run counts its own, so the hot loop shares nothing.</summary>
    public long Skipped { get; set; }

    /// <summary>Records a position this search read: matched, or holding a cell a narrowed search must look at again.</summary>
    public void Mark(long position, bool match, bool recheckRow)
    {
        if (keepMatched is null || (!match && !recheckRow)) return;
        var bit = 1UL << (int)(position & 63);
        Interlocked.Or(ref (match ? keepMatched : keepRecheck!)[position >> 6], bit);
    }

    /// <summary>The outcome with what the rows passed over answer (a truncated cell that did not match), and this search's
    /// memo kept for the next.</summary>
    public SearchOutcome Finish(ResultSetBuffer set, SearchOutcome found)
    {
        var outcome = approximate && !found.Approximate ? found with { Approximate = true } : found;
        if (keepMatched is not null)
        {
            // The rows passed over stay ruled out under the last memo's rules, so what they need carries on.
            var needs = new SearchNarrowing.Needs[matchers.Length];
            for (var c = 0; c < needs.Length; c++) needs[c] = (matchers[c]?.Needs ?? 0) | (from?.Needs[c] ?? 0);
            set.KeepSearchMemo(new SearchMemo(text, viewId, rows, kinds, needs, folds, keepMatched, keepRecheck!, outcome.Approximate, Elsewhere, reserved));
            kept = true;
        }
        return outcome;
    }

    /// <summary>Returns the room reserved for a memo that was not kept (the search stopped or failed).</summary>
    public void Dispose(ResultSetBuffer set)
    {
        if (reserved > 0 && !kept) set.ReturnWork(reserved);
    }
}
