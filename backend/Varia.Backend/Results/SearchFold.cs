using System.Collections.Concurrent;
using System.Globalization;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>A culture's search fold for one set of compare options: every vouched UTF-16 code unit mapped to the
/// representative of the code units the culture's collator gives the same sort key under those options (and ignoring case
/// when they ignore accents, as the compare's IndexOf then does), with empty keys dropped. A cell a culture compare finds the text in then holds the text's fold, folded, as an ordinal substring, so an
/// ordinal search of the folds rules most cells out before the culture compare, which stays the judge
/// (<see cref="ResultSearcher.MatcherFor"/>). Built from the collator, never by hand: a hand-written fold misses ß, æ,
/// final sigma, kana, Arabic-Indic digits and more. Only for the cultures <see cref="Verified"/> lists, and only for text
/// made of the characters <see cref="Vouched"/> lists after NFC: collation is not per character (Japanese ー and ゝ repeat
/// the sound before them, root joins l·l, Yiddish ligatures and Arabic presentation forms equal letter pairs), so any other
/// character sends its cell to the culture compare alone.</summary>
internal sealed class SearchFold
{
    /// <summary>The cultures (LCIDs) whose fold SearchFoldChecks verifies (its differential and key-class checks, and longer
    /// out-of-tree runs of both, found no difference): Latin1_General and SQL_Latin1_General collations are 1033. Danish,
    /// Norwegian, Hungarian and Croatian are not: their collations treat a letter as a pair of letters (å as aa, dž) in ways a
    /// per-character fold cannot follow, and the long run finds misses. Nor is Thai: its compare finds ӽ in ӿ though their sort
    /// keys differ.</summary>
    internal static readonly int[] Verified =
    [
        1025, 1026, 1028, 1029, 1031, 1032, 1033, 1034, 1035, 1036, 1037, 1039, 1040, 1041, 1042, 1043, 1045, 1046, 1048, 1049,
        1051, 1052, 1053, 1055, 1058, 1060, 1061, 1062, 1063, 1066, 1068, 1087, 2052, 2070, 3082
    ];

    // About 400 KB a fold, kept for the process: a search, or packing a page with a column in the culture (its Find filter,
    // PageFilter), builds one for the column's culture and options, so a session holds
    // a handful (at most 35 cultures times 16 option sets, about 220 MB, if every one were searched).
    private static readonly ConcurrentDictionary<(int Lcid, CompareOptions Options), Lazy<Task<SearchFold>>> folds = new();

    /// <summary>The fold for a culture and compare options once it is built, else null (and the build started on the thread
    /// pool, so a search never waits for it: until it is ready the culture compare runs alone). Null for a culture that is
    /// not verified. A fold is per option set because the options are not monotonic: Estonian finds Ｚ in Z case-sensitively
    /// but not case-insensitively, so a fold built from one option set's keys can rule out another's match.</summary>
    public static SearchFold? For(int lcid, CompareOptions options)
    {
        if (Array.IndexOf(Verified, lcid) < 0) return null;
        var build = Lazy(lcid, options).Value;
        return build.IsCompletedSuccessfully ? build.Result : null;
    }

    /// <summary>Sets a fold's build (the checks): null forgets it, as if never built, and a failed task stands for a build
    /// that failed.</summary>
    internal static void Seed(int lcid, CompareOptions options, Task<SearchFold>? build)
    {
        if (build is null) folds.TryRemove((lcid, options), out _);
        else folds[(lcid, options)] = new Lazy<Task<SearchFold>>(() => build);
    }

    /// <summary>The fold for a culture and options, waiting for its build, or null for a culture that is not verified (a
    /// page's Find filter, built off the search, on the packer's thread).</summary>
    public static SearchFold? Awaited(int lcid, CompareOptions options)
    {
        if (Array.IndexOf(Verified, lcid) < 0) return null;
        var build = Lazy(lcid, options).Value;
        // A build that failed (out of memory) stays failed: no fold, as For answers, never an exception on the packer.
        if (!build.IsCompleted)
            try { build.Wait(); }
            catch (AggregateException) { }
        return build.IsCompletedSuccessfully ? build.Result : null;
    }

    /// <summary>The fold for a culture and options, waiting for its build (the checks and benchmarks).</summary>
    internal static SearchFold Ready(int lcid, CompareOptions options)
    {
        if (Array.IndexOf(Verified, lcid) < 0) throw new ArgumentOutOfRangeException(nameof(lcid), "The culture's fold is not verified.");
        return Lazy(lcid, options).Value.GetAwaiter().GetResult();
    }

    private static Lazy<Task<SearchFold>> Lazy(int lcid, CompareOptions options) =>
        folds.GetOrAdd((lcid, options), key => new Lazy<Task<SearchFold>>(() => Task.Run(() => Build(key.Lcid, key.Options))));

    /// <summary>Builds any culture's fold, verified or not (the differential check measures unverified ones).</summary>
    internal static SearchFold Build(int lcid, CompareOptions options) => new(CultureInfo.GetCultureInfo(lcid).CompareInfo, options);

    // Each code unit's fold: one character (the common case), or Multiple when it folds to several (ß to ss, a Hangul
    // syllable to its jamo but in Korean) or none. Those are packed, not a dictionary of strings, which took 1 MB a
    // fold: each code unit's entry (from 1), and each entry's fold as a range of one pool.
    private readonly char[] single = new char[65536];
    private readonly ushort[] multipleEntries = new ushort[65536];
    private readonly int[] multipleStarts;
    private readonly char[] multiplePool;
    private const char Multiple = '\uFFFF';
    // Each code unit's kind: Unvouched (its cell goes to the compare), Plain (vouched and NFC-stable) or Accent (a combining
    // accent, vouched only once NFC composes it into a plain letter).
    private readonly byte[] kinds = new byte[65536];
    private const byte Unvouched = 0, Plain = 1, Accent = 2;
    // The ASCII range's folds, for the UTF-8 fast path: a byte below 0x80 is its character.
    private readonly string[] ascii = new string[128];

    private SearchFold(CompareInfo info, CompareOptions options)
    {
        // Ignoring accents, the compare's IndexOf ignores case too (it finds n in N) though its sort keys keep case, so the
        // keys then ignore case as well.
        var keyed = (options & CompareOptions.IgnoreNonSpace) != 0 ? options | CompareOptions.IgnoreCase : options;
        string Key(string text) => Convert.ToBase64String(info.GetSortKey(text, keyed).KeyData);
        var emptyKey = Key("");
        var japanese = info.LCID == 1041;
        // Which code units the fold vouches for here, and their keys (others' keys only when a decomposition needs them).
        var vouched = new bool[65536];
        for (var c = 0; c < 65536; c++) vouched[c] = Vouched((char)c) && !(japanese && Repeating((char)c)) && Stable((char)c);
        var keys = new string?[65536];
        string KeyOf(char c) => keys[c] ??= Key(c.ToString());
        // A group's representative: a one or two letter ASCII string with its key if there is one (ß to ss, æ to ae), else
        // the compatibility decomposition of its lowest vouched code unit, folded, when that has the key, else that code unit.
        // Every member of a group maps to the same representative, so a cell and a text folded agree. (No vouched code unit
        // has the key of three ASCII letters; the compatibility decomposition covers the rest.)
        var asciiKeys = new Dictionary<string, string>();
        void Candidate(string s)
        {
            var key = Key(s);
            if (key != emptyKey) asciiKeys.TryAdd(key, s);
        }
        for (var c = 0x20; c < 0x7F; c++) Candidate(char.ToLowerInvariant((char)c).ToString());
        for (var a = 'a'; a <= 'z'; a++) for (var b = 'a'; b <= 'z'; b++) Candidate(new string([a, b]));
        var lowest = new Dictionary<string, char>();
        for (var c = 0; c < 65536; c++)
            if (vouched[c] && KeyOf((char)c) is var key && key != emptyKey) lowest.TryAdd(key, (char)c);
        var representatives = new Dictionary<string, string>();
        string Representative(char unit, int depth)
        {
            var key = KeyOf(unit);
            if (key == emptyKey) return "";
            if (asciiKeys.TryGetValue(key, out var plain)) return plain;
            if (representatives.TryGetValue(key, out var known)) return known;
            var low = (lowest.TryGetValue(key, out var first) ? first : unit).ToString();
            var chosen = low;
            if (depth < 4)
            {
                // A noncharacter (U+FFFE) cannot be normalized: it stays itself.
                string decomposed;
                try { decomposed = low.Normalize(NormalizationForm.FormKD); }
                catch (ArgumentException) { decomposed = low; }
                if (decomposed != low)
                {
                    var composed = new StringBuilder();
                    foreach (var part in decomposed)
                        if (!char.IsSurrogate(part)) composed.Append(Representative(part, depth + 1));
                    if (composed.Length > 0 && Key(composed.ToString()) == key) chosen = composed.ToString();
                }
            }
            representatives[key] = chosen;
            return chosen;
        }
        var starts = new List<int>();
        var pool = new StringBuilder();
        for (var c = 0; c < 65536; c++)
        {
            var unit = (char)c;
            if (c is >= 0x300 and <= 0x36F) kinds[c] = Accent;
            if (!vouched[c])
            {
                single[c] = Multiple;
                continue;
            }
            kinds[c] = Plain;
            var fold = Representative(unit, 0);
            if (fold.Length == 1 && fold[0] != Multiple) single[c] = fold[0];
            else
            {
                single[c] = Multiple;
                starts.Add(pool.Length);
                multipleEntries[c] = checked((ushort)starts.Count);
                pool.Append(fold);
            }
            if (c < 128) ascii[c] = fold;
        }
        starts.Add(pool.Length);
        multipleStarts = [.. starts];
        multiplePool = pool.ToString().ToCharArray();
    }

    private static bool Stable(char c)
    {
        try { return c.ToString().IsNormalized(NormalizationForm.FormC); }
        catch (ArgumentException) { return false; }
    }

    /// <summary>The code units the fold vouches for, whose collation in the verified cultures depends on no neighbour (the
    /// key-class scan in SearchFoldChecks finds no two strings of them alike to the compare and folded apart): tab, line
    /// breaks and printable ASCII; no-break space, Latin-1 and Extended-A letters (and × ÷), and Extended-B's Vietnamese ơ ư, pinyin ǎ
    /// to ǜ and Romanian ș ț; Greek and Cyrillic letters; Hebrew letters; Arabic letters from أ and Arabic-Indic digits;
    /// dashes (U+2010 to U+2015) and quotes (U+2018 to U+201F); hiragana and katakana letters, full-width and half-width; CJK ideographs; Hangul syllables;
    /// full-width ASCII; and, but in Japanese, the <see cref="Repeating"/> marks. Not ·, which root joins with l, nor the
    /// digraph letters (ǆ, ǉ, ǌ), ء and آ (آ is ءء to an accent-insensitive compare), the voiced marks, the dot leaders (‥ is ․․ to a case-sensitive compare), ligatures,
    /// presentation forms, enclosed or squared characters, jamo or combining marks left after NFC.</summary>
    internal static bool Vouched(char c) =>
        (c is '\t' or '\n' or '\r' or (>= ' ' and <= '~') or '\u00A0' or (>= '\u00C0' and <= '\u017F')
        or '\u01A0' or '\u01A1' or '\u01AF' or '\u01B0' or (>= '\u01CD' and <= '\u01DC') or (>= '\u0218' and <= '\u021B')
        or (>= '\u0386' and <= '\u03CE' and not '\u0387') or (>= '\u0400' and <= '\u0482') or (>= '\u048A' and <= '\u04FF')
        or (>= '\u05D0' and <= '\u05EA') or (>= '\u0623' and <= '\u063A') or (>= '\u0641' and <= '\u064A') or (>= '\u0660' and <= '\u0669')
        or (>= '\u2010' and <= '\u2015') or (>= '\u2018' and <= '\u201F') or (>= '\u3041' and <= '\u3096') or (>= '\u30A1' and <= '\u30FA')
        or (>= '\u4E00' and <= '\u9FFF') or (>= '\uAC00' and <= '\uD7A3') or (>= '\uFF01' and <= '\uFF5E')
        or (>= '\uFF66' and <= '\uFF9D')) || Repeating(c);

    /// <summary>The prolonged sound mark (ー, ｰ) and the kana iteration marks (ゝ, ゞ, ヽ, ヾ): vouched in every verified culture but
    /// Japanese, whose collation reads them as the sound before them.</summary>
    internal static bool Repeating(char c) => c is '\u30FC' or '\uFF70' or '\u309D' or '\u309E' or '\u30FD' or '\u30FE';

    /// <summary>A text's fold, or null when it holds a character the fold cannot vouch for, or folds to nothing.</summary>
    public string? FoldText(string text)
    {
        var buffer = new char[Math.Max(16, text.Length * 3)];
        if (!TryFold(text, ref buffer, out var length) || length == 0) return null;
        return new string(buffer, 0, length);
    }

    /// <summary>Folds UTF-16 text (normalized to NFC first, so a letter and its decomposed form fold alike) into
    /// <paramref name="buffer"/>, grown as needed. False when it holds a character the fold cannot vouch for.</summary>
    public bool TryFold(ReadOnlySpan<char> text, ref char[] buffer, out int length)
    {
        length = 0;
        // Only vouched characters and combining accents; with an accent, NFC must compose every one into a vouched letter.
        // (Checked first: a noncharacter or half of a supplementary character, unvouched, would make normalizing throw.)
        var accents = false;
        foreach (var c in text)
        {
            var kind = kinds[c];
            if (kind == Unvouched) return false;
            accents |= kind == Accent;
        }
        if (accents)
        {
            string normal;
            try { normal = new string(text).Normalize(NormalizationForm.FormC); }
            catch (ArgumentException) { return false; }
            foreach (var c in normal) if (kinds[c] != Plain) return false;
            text = normal.AsSpan();
        }
        if (buffer.Length < text.Length + 16) buffer = new char[Math.Max(text.Length + 16, 2 * buffer.Length)];
        foreach (var c in text)
        {
            var folded = single[c];
            if (folded != Multiple && length < buffer.Length)
            {
                buffer[length++] = folded;
                continue;
            }
            if (folded != Multiple) Append(ref buffer, ref length, folded);
            else
            {
                var entry = multipleEntries[c];
                if (entry == 0) return false;
                for (var k = multipleStarts[entry - 1]; k < multipleStarts[entry]; k++) Append(ref buffer, ref length, multiplePool[k]);
            }
        }
        return true;
    }

    /// <summary>Folds an ASCII-only UTF-8 cell straight from its bytes. False when a byte is not ASCII.</summary>
    public bool TryFoldAscii(ReadOnlySpan<byte> utf8, ref char[] buffer, out int length)
    {
        length = 0;
        if (!System.Text.Ascii.IsValid(utf8)) return false;
        foreach (var b in utf8) if (kinds[b] != Plain) return false;
        if (buffer.Length < utf8.Length + 16) buffer = new char[Math.Max(utf8.Length + 16, 2 * buffer.Length)];
        foreach (var b in utf8)
        {
            var fold = ascii[b];
            if (fold.Length == 1 && length < buffer.Length) buffer[length++] = fold[0];
            else foreach (var part in fold) Append(ref buffer, ref length, part);
        }
        return true;
    }

    private static void Append(ref char[] buffer, ref int length, char c)
    {
        if (length == buffer.Length) Array.Resize(ref buffer, Math.Max(16, buffer.Length * 2));
        buffer[length++] = c;
    }
}
