using System.Numerics;

namespace Varia.Backend.Search;

/// <summary>Fuzzy name matching (Search Objects' Fuzzy Match): the search's words, split as a name is (at punctuation, camelCase
/// and letter/digit boundaries), must each find a word of the name that equals it, starts with it, is within a few edits of it
/// (optimal string alignment distance: one edit for a 3 to 5 letter word, two from 6) or sounds like it (<see cref="Phonetic"/>).
/// Nothing is kept in the index: a name's words are found per search, so fuzzy matching costs no memory under IndexBudget, and
/// one matcher serves one search on one thread (it reuses its buffers). Case is folded, Whole Word allows whole words only (no
/// prefixes), and a search with a dot matches the words before its last dot against the schema's and a child's parent's and the
/// rest against the name. A search of more than <see cref="MaxWords"/> words, or with a word longer than
/// <see cref="MaxWordChars"/>, matches exactly only.</summary>
internal sealed class FuzzyName
{
    /// <summary>The most words a fuzzy search may have (objectSearchLimits.fuzzyWords).</summary>
    public const int MaxWords = 8;
    /// <summary>The longest word fuzzy matching compares, in UTF-16 code units (objectSearchLimits.fuzzyWordChars).</summary>
    public const int MaxWordChars = 64;

    /// <summary>How a word matched: exactly or as a prefix, within edits, or by sound. A name's tier is its worst word's.</summary>
    public enum Tier { Words = 0, Edits = 1, Sound = 2 }

    /// <summary>What a sound match costs, against at most two edits for a typo.</summary>
    private const int SoundCost = 3;

    private sealed record Word(string Text, int Edits, string Key, ulong Mask);

    private readonly Word[] words;
    private readonly Word[] qualifiers;
    private readonly bool wholeWord;
    // Scratch space for one search.
    private readonly List<(int Start, int Length)> spans = new(16);
    private readonly List<(int Start, int Length)> others = new(16);
    private ulong[] masks = new ulong[16];
    private char[] folded = new char[256];
    private readonly char[] joined = new char[MaxWordChars];
    private readonly char[] codes = new char[2 * MaxWordChars + 2];
    private int[] previous = new int[MaxWordChars + 2], current = new int[MaxWordChars + 2], before = new int[MaxWordChars + 2];

    private FuzzyName(Word[] words, Word[] qualifiers, bool wholeWord)
    {
        this.words = words;
        this.qualifiers = qualifiers;
        this.wholeWord = wholeWord;
    }

    /// <summary>The fuzzy matcher for a search's text, or null when it has no word to match or too many or too long ones.</summary>
    public static FuzzyName? Create(string text, bool wholeWord)
    {
        var dot = text.LastIndexOf('.');
        var name = Prepare(dot < 0 ? text : text[(dot + 1)..]);
        var qualifier = dot < 0 ? [] : Prepare(text[..dot]);
        if (name is null || qualifier is null || name.Length == 0 || name.Length + qualifier.Length > MaxWords) return null;
        return new(name, qualifier, wholeWord);
    }

    private static Word[]? Prepare(string text)
    {
        var found = new List<(int Start, int Length)>();
        Split(text, found);
        if (found.Count > MaxWords || found.Any(span => span.Length > MaxWordChars)) return null;
        return [.. found.Select(span =>
        {
            var word = text.Substring(span.Start, span.Length).ToLowerInvariant();
            // A number matches only itself or as a prefix: Sales2019 is not a typo of Sales2018, and 2000 does not sound like 20.
            if (char.IsDigit(word[0])) return new Word(word, 0, "", Mask(word));
            return new Word(word, word.Length < 3 ? 0 : word.Length < 6 ? 1 : 2, word.Length < 4 ? "" : Phonetic(word), Mask(word));
        })];
    }

    /// <summary>The words of an identifier: runs of letters and digits, split where lower case meets upper (orderLines), before
    /// the last capital of a run that goes on in lower case (XMLParser: XML, Parser), and between letters and digits.</summary>
    internal static void Split(string value, List<(int Start, int Length)> into)
    {
        into.Clear();
        var start = -1;
        for (var at = 0; at <= value.Length; at++)
        {
            var c = at < value.Length ? value[at] : '\0';
            if (!char.IsLetterOrDigit(c))
            {
                if (start >= 0) into.Add((start, at - start));
                start = -1;
                continue;
            }
            if (start < 0) { start = at; continue; }
            var p = value[at - 1];
            var cut = (char.IsLower(p) && char.IsUpper(c))
                || (char.IsUpper(p) && char.IsUpper(c) && at + 1 < value.Length && char.IsLower(value[at + 1]))
                || (char.IsDigit(p) != char.IsDigit(c));
            if (cut) { into.Add((start, at - start)); start = at; }
        }
    }

    /// <summary>The letters a word holds, a to z and 0 to 9 each a bit and every other character one shared bit: a search word
    /// with more letters the name's word lacks than its edits allow cannot be within them (each edit brings in at most one).</summary>
    private static ulong Mask(ReadOnlySpan<char> word)
    {
        var mask = 0UL;
        foreach (var c in word) mask |= c is >= 'a' and <= 'z' ? 1UL << (c - 'a') : c is >= '0' and <= '9' ? 1UL << (26 + c - '0') : 1UL << 63;
        return mask;
    }

    /// <summary>Whether <paramref name="name"/> matches, its tier, its total cost (edits, or 3 for a sound match), and the span
    /// from its first matched word to its last.</summary>
    public bool Match(string name, string? schema, string? parent, out Tier tier, out int cost, out int start, out int length)
    {
        (tier, cost, start, length) = (Tier.Words, 0, 0, 0);
        if (qualifiers.Length > 0)
        {
            // The words before the dot may match the schema's and a child's parent's words, together (sales.custmer.adress).
            var outer = schema is null ? parent : parent is null ? schema : schema + "." + parent;
            if (outer is null || !Prepare(outer, others)) return false;
            if (!MatchAll(qualifiers, others, out tier, out cost, out _, out _)) return false;
        }
        if (!Prepare(name, spans)) return false;
        if (!MatchAll(words, spans, out var nameTier, out var nameCost, out start, out var end))
        {
            // A search typed without separators (custmerorders) is compared with the whole name's letters and digits too.
            if (words.Length != 1 || spans.Count < 2 || !Joined(name.Length, out nameTier, out nameCost)) return false;
            (start, end) = (spans[0].Start, spans[^1].Start + spans[^1].Length);
        }
        tier = (Tier)Math.Max((int)tier, (int)nameTier);
        cost += nameCost;
        length = end - start;
        return true;
    }

    /// <summary>Folds <paramref name="value"/>'s case into the buffer, splits it into words and finds each word's letters.</summary>
    private bool Prepare(string value, List<(int Start, int Length)> parts)
    {
        if (folded.Length < value.Length) folded = new char[Math.Max(value.Length, folded.Length * 2)];
        for (var i = 0; i < value.Length; i++) folded[i] = char.ToLowerInvariant(value[i]);
        Split(value, parts);
        if (masks.Length < parts.Count) masks = new ulong[Math.Max(parts.Count, masks.Length * 2)];
        for (var i = 0; i < parts.Count; i++) masks[i] = Mask(folded.AsSpan(parts[i].Start, parts[i].Length));
        return parts.Count > 0;
    }

    private bool MatchAll(Word[] asked, List<(int Start, int Length)> parts, out Tier tier, out int cost, out int start, out int end)
    {
        (tier, cost, start, end) = (Tier.Words, 0, int.MaxValue, 0);
        foreach (var word in asked)
        {
            var best = -1;
            var bestTier = Tier.Sound;
            var bestCost = int.MaxValue;
            for (var i = 0; i < parts.Count; i++)
            {
                if (!Compare(word, folded.AsSpan(parts[i].Start, parts[i].Length), masks[i], out var t, out var c)) continue;
                if (best < 0 || t < bestTier || (t == bestTier && c < bestCost)) (best, bestTier, bestCost) = (i, t, c);
                if (t == Tier.Words) break;
            }
            if (best < 0) return false;
            tier = (Tier)Math.Max((int)tier, (int)bestTier);
            cost += bestCost;
            start = Math.Min(start, parts[best].Start);
            end = Math.Max(end, parts[best].Start + parts[best].Length);
        }
        return true;
    }

    /// <summary>The single search word against the name's letters and digits run together (the folded buffer's).</summary>
    private bool Joined(int length, out Tier tier, out int cost)
    {
        (tier, cost) = (Tier.Edits, 0);
        var word = words[0];
        if (word.Edits == 0) return false;
        var count = 0;
        for (var i = 0; i < length; i++)
            if (char.IsLetterOrDigit(folded[i]))
            {
                if (count == MaxWordChars) return false;
                joined[count++] = folded[i];
            }
        if (Math.Abs(count - word.Text.Length) > word.Edits) return false;
        var distance = Distance(word.Text, joined.AsSpan(0, count), word.Edits, false);
        if (distance < 0) return false;
        (tier, cost) = (distance == 0 ? Tier.Words : Tier.Edits, distance);
        return true;
    }

    /// <summary>Whether one word of the search matches one (case-folded) word of a name, and how.</summary>
    private bool Compare(Word word, ReadOnlySpan<char> part, ulong mask, out Tier tier, out int cost)
    {
        (tier, cost) = (Tier.Words, 0);
        var asked = word.Text.AsSpan();
        if (part.Length > MaxWordChars) return false;
        if (part.SequenceEqual(asked)) return true;
        if (!wholeWord && part.Length > asked.Length && part.StartsWith(asked)) return true;
        // A short word's first letter must be right, and only a word of 4 letters or more may be a typo of a longer word's start:
        // otherwise ord would find Product (prod is one edit away) and most three-letter words would match each other.
        var prefix = !wholeWord && asked.Length >= 4;
        if (word.Edits > 0 && part.Length >= asked.Length - word.Edits && (prefix || part.Length <= asked.Length + word.Edits)
            && (word.Edits > 1 || part[0] == asked[0]) && BitOperations.PopCount(word.Mask & ~mask) <= word.Edits)
        {
            var distance = Distance(word.Text, part, word.Edits, prefix);
            if (distance > 0) { (tier, cost) = (Tier.Edits, distance); return true; }
        }
        // Only a word of 4 letters or more is matched by sound (three-letter consonant skeletons are mostly one another's), and
        // only one whose key has 4 codes or more by a longer word's start (store, STR, would otherwise find String and Street).
        if (word.Key.Length >= 2 && part.Length >= 2 && Sounds(part, word.Key, prefix && word.Key.Length >= 4, codes))
        {
            (tier, cost) = (Tier.Sound, SoundCost);
            return true;
        }
        return false;
    }

    /// <summary>The optimal string alignment distance (Damerau-Levenshtein without repeated edits of one substring) between the
    /// search's word and the name's, or with <paramref name="prefix"/> between it and the nearest prefix of the name's word, when
    /// at most <paramref name="bound"/>; otherwise -1. The rows are bounded by the word lengths (at most 64).</summary>
    internal int Distance(string asked, ReadOnlySpan<char> part, int bound, bool prefix)
    {
        var n = part.Length;
        if (n + 2 > previous.Length) return -1;
        for (var j = 0; j <= n; j++) previous[j] = j;
        for (var i = 1; i <= asked.Length; i++)
        {
            current[0] = i;
            var smallest = i;
            for (var j = 1; j <= n; j++)
            {
                var same = asked[i - 1] == part[j - 1] ? 0 : 1;
                var value = Math.Min(Math.Min(previous[j] + 1, current[j - 1] + 1), previous[j - 1] + same);
                if (i > 1 && j > 1 && asked[i - 1] == part[j - 2] && asked[i - 2] == part[j - 1]) value = Math.Min(value, before[j - 2] + 1);
                current[j] = value;
                smallest = Math.Min(smallest, value);
            }
            // Every later row's values are at least this row's smallest.
            if (smallest > bound) return -1;
            (before, previous, current) = (previous, current, before);
        }
        var result = previous[n];
        if (prefix)
            for (var j = Math.Max(1, asked.Length - bound); j < n && j <= asked.Length + bound; j++) result = Math.Min(result, previous[j]);
        return result <= bound ? result : -1;
    }

    /// <summary>A word's sound, a small Metaphone-style key: silent initial letters dropped (kn, gn, pn, wr, ps), a leading vowel
    /// kept as A and later vowels dropped, letters that sound alike given one code (c, k and q as K, ph, f and v as F, z and soft c
    /// as S, soft g as J, sh, ch, sio and tio as X, th as 0, d as T), h, w and y kept only before a vowel, digits kept, and a code
    /// repeated without a vowel between written once. Kustomer and Customer share KSTMR, Fone and Phone FN.</summary>
    internal static string Phonetic(string word)
    {
        var output = new char[2 * word.Length + 2];
        var key = new KeyWriter(output, null);
        Encode(word.ToLowerInvariant(), ref key, false);
        return new string(output, 0, Math.Min(key.Length, output.Length));
    }

    /// <summary>Whether a case-folded word's key is <paramref name="target"/> (or, with <paramref name="prefix"/>, starts with it),
    /// stopping at the first code that differs.</summary>
    private static bool Sounds(ReadOnlySpan<char> word, string target, bool prefix, char[] buffer)
    {
        var key = new KeyWriter(buffer, target);
        Encode(word, ref key, prefix);
        return !key.Off && (prefix ? key.Length >= target.Length : key.Length == target.Length);
    }

    /// <summary>Collects a key's codes, comparing them with a target as they come.</summary>
    private ref struct KeyWriter(Span<char> output, string? target)
    {
        private readonly Span<char> output = output;
        public readonly string? Target = target;
        public int Length;
        public bool Off;
        private char last;

        public void Put(char code)
        {
            if (code == last) return;
            last = code;
            if (Target is not null && Length < Target.Length && Target[Length] != code) Off = true;
            if (Length < output.Length) output[Length] = code;
            Length++;
        }

        /// <summary>A vowel: the next code is written even when it repeats the last (quantity's two Ts).</summary>
        public void Gap() => last = '\0';
    }

    private static void Encode(ReadOnlySpan<char> w, ref KeyWriter key, bool prefix)
    {
        var at = 0;
        if (w.Length > 1 && (w.StartsWith("kn") || w.StartsWith("gn") || w.StartsWith("pn") || w.StartsWith("wr") || w.StartsWith("ps"))) at = 1;
        else if (w.Length > 0 && w[0] == 'x') { key.Put('S'); at = 1; }
        for (var i = at; i < w.Length; i++)
        {
            // A target is settled by its first differing code, a prefix target once all its codes are written, and an exact one once
            // the key is longer.
            if (key.Off || (key.Target is not null && (prefix ? key.Length >= key.Target.Length : key.Length > key.Target.Length))) return;
            var c = w[i];
            var next = At(w, i + 1);
            if (c is >= '0' and <= '9') { key.Put(c); continue; }
            if (Vowel(c)) { if (i == at) key.Put('A'); else key.Gap(); continue; }
            switch (c)
            {
                case 'b': if (!(i == w.Length - 1 && At(w, i - 1) == 'm')) key.Put('B'); break;
                case 'c':
                    if (next == 'h') { key.Put('X'); i++; }
                    else if (next is 'i' or 'e' or 'y') key.Put('S');
                    else key.Put('K');
                    break;
                case 'd': if (next == 'g' && At(w, i + 2) is 'e' or 'i' or 'y') { key.Put('J'); i++; } else key.Put('T'); break;
                case 'g':
                    if (next == 'h') i++;
                    else if (next == 'n') { }
                    else if (next is 'e' or 'i' or 'y') key.Put('J');
                    else key.Put('K');
                    break;
                case 'h': if (Vowel(next) && !(At(w, i - 1) is 'c' or 's' or 'p' or 't' or 'g')) key.Put('H'); break;
                case 'p': if (next == 'h') { key.Put('F'); i++; } else key.Put('P'); break;
                case 'q' or 'k': key.Put('K'); break;
                case 's':
                    if (next == 'h') { key.Put('X'); i++; }
                    else if (next == 'i' && At(w, i + 2) is 'o' or 'a') key.Put('X');
                    else key.Put('S');
                    break;
                case 't':
                    if (next == 'h') { key.Put('0'); i++; }
                    else if (next == 'i' && At(w, i + 2) is 'o' or 'a') key.Put('X');
                    else if (next == 'c' && At(w, i + 2) == 'h') { }
                    else key.Put('T');
                    break;
                case 'v': key.Put('F'); break;
                case 'w': if (Vowel(next)) key.Put('W'); break;
                case 'y': if (Vowel(next)) key.Put('Y'); break;
                case 'x': key.Put('K'); key.Put('S'); break;
                case 'z': key.Put('S'); break;
                default: if (c is >= 'a' and <= 'z') key.Put(char.ToUpperInvariant(c)); break;
            }
        }
    }

    private static char At(ReadOnlySpan<char> w, int i) => i >= 0 && i < w.Length ? w[i] : '\0';
    private static bool Vowel(char c) => c is 'a' or 'e' or 'i' or 'o' or 'u';
}
