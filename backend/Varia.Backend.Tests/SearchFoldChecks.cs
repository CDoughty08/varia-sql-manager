using System.Globalization;
using System.Text;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The search fold (SearchFold) and the culture matcher's pre-check: with the pre-check, a culture matcher finds
/// exactly what the culture compare alone finds, for every verified culture and every option set, over fuzzed text built
/// from characters a culture compare treats alike (ß and ss, æ and ae, final sigma, kana, full-width and Arabic-Indic
/// digits, ignorable characters, decomposed letters) and fictional multilingual text, and over cells where collation
/// depends on neighbouring characters; strings the loosest compare finds equal fold alike; cultures that join letters into
/// one are not verified; a cell the fold cannot vouch for goes to the compare; the pre-check stops when most cells pass it.</summary>
internal static class SearchFoldChecks
{
    // SqlCompareOptions: IgnoreCase 1, IgnoreNonSpace 2, IgnoreKanaType 8, IgnoreWidth 16.
    private static readonly (string Name, int Options)[] OptionSets = [("CI_AI", 1 | 2 | 8 | 16), ("CI_AS", 1 | 8 | 16), ("CS_AI", 2 | 8 | 16), ("CS_AS", 8 | 16)];
    private const CompareOptions Loosest = CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace | CompareOptions.IgnoreKanaType | CompareOptions.IgnoreWidth;

    /// <summary>Characters and strings a culture compare may treat alike, in groups.</summary>
    internal static readonly string[][] Groups =
    [
        ["ss", "ß", "ẞ", "SS"], ["ae", "æ", "Æ", "AE"], ["oe", "œ", "Œ"], ["fi", "ﬁ"], ["fl", "ﬂ"], ["ffi", "ﬃ"], ["ij", "ĳ", "Ĳ"],
        ["a", "á", "à", "â", "ä", "å", "ａ", "Ａ", "A", "a\u0301", "ā"], ["e", "é", "è", "ê", "ë", "e\u0301", "ｅ", "E", "ę"],
        ["o", "ø", "ö", "ó", "Ø", "o\u0308"], ["l", "ł", "Ł", "L"], ["d", "đ", "ð", "Đ"], ["i", "ı", "İ", "I", "ｉ", "í"],
        ["c", "ç", "C", "č"], ["n", "ñ", "N", "n\u0303"], ["k", "K", "K"], ["σ", "ς", "Σ"], ["か", "カ", "ｶ", "が", "か\u3099"],
        ["2", "٢", "２", "²", "②", "₂"], ["1", "١", "１", "¹", "①"], ["th", "þ", "Þ"], ["й", "и\u0306", "Й"], ["u", "ü", "ú", "u\u0308", "U"],
        ["", "\u00AD", "\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u0301"], [" ", "\u00A0", "\u3000", "\u2009"],
        ["-", "–", "‐", "−"], ["A", "𝐀", "𝔸"], ["dz", "ǆ", "Ǆ", "dž"], ["°c", "℃"], ["1/2", "½"], ["'", "’"],
        ["g", "ğ", "G"], ["s", "ş", "ś", "š", "S"], ["z", "ž", "Z"], ["r", "ř", "R"], ["t", "ť", "T"], ["y", "ý", "ÿ", "Y"],
        ["ч", "Ч"], ["aa", "å", "Å", "AA"], ["cs", "CS"], ["ch", "CH"], ["ll", "LL"], ["lj", "ǉ"], ["ö", "ő", "ø"], ["ё", "е\u0308", "е"],
        ["ア", "あ", "ｱ"], ["한", "한"], ["数", "數"], ["ㄱ", "ᄀ"], ["ก", "เก", "กำ"], ["क", "क्ष", "कि"], ["😀", "👍🏽", "👨\u200D👩\u200D👧"],
    ];

    /// <summary>Fictional sentences in several scripts, cut into cells and texts.</summary>
    internal static readonly string[] Sentences =
    [
        "The quarterly reconciliation for Fabrikam closed with 3 open items; see ticket REF-00042.",
        "Die Straße zum Lager ist gesperrt, bitte über die Brücke ausweichen. Größe: 12 m².",
        "L'écriture du journal a échoué : le fichier « données.mdf » est verrouillé par un autre processus.",
        "La conexión con el servidor se cerró; reintente la operación en unos minutos, señor Núñez.",
        "Η σύνδεση με τον διακομιστή έκλεισε απροσδόκητα. Παρακαλώ δοκιμάστε ξανά.",
        "Соединение с сервером было закрыто. Повторите попытку позже, Ёлкин.",
        "İstanbul deposundaki sayım tamamlandı; ışıklı raflar ve IĞDIR şubesi bekliyor.",
        "サーバーとの接続が切断されました。ﾃﾞｰﾀﾍﾞｰｽを確認してください。",
        "서버와의 연결이 끊어졌습니다. 잠시 후 다시 시도하십시오.",
        "与服务器的连接已关闭。請稍後再試，數據庫正在恢復。",
        "تم إغلاق الاتصال بالخادم. يرجى المحاولة مرة أخرى بعد ٢ دقيقة.",
        "החיבור לשרת נסגר. נסה שוב מאוחר יותר.",
        "Połączenie z serwerem zostało zamknięte; spróbuj ponownie, Łukasz.",
        "การเชื่อมต่อกับเซิร์ฟเวอร์ถูกปิดแล้ว กรุณาลองใหม่อีกครั้ง",
        "सर्वर से कनेक्शन बंद हो गया है। कृपया बाद में पुनः प्रयास करें।",
        "Encyclopædia œuvre ﬁnancial ﬃliation Ĳssel ǆungla ℃ ½ – naïve coöperate façade 😀 done.",
    ];

    public static void Run(Action<bool, string> check, int iterations = 1_500)
    {
        // Each culture on a worker of its own: building a fold takes 0.05 to 0.3 s.
        var outcomes = new (int Lcid, string Name, int Cases, int Found, List<string> Differences)[SearchFold.Verified.Length * OptionSets.Length];
        Parallel.For(0, SearchFold.Verified.Length, index =>
        {
            var lcid = SearchFold.Verified[index];
            for (var o = 0; o < OptionSets.Length; o++)
            {
                var (cases, found, differences) = Differential(lcid, OptionSets[o].Options, iterations, 1000 + lcid);
                outcomes[index * OptionSets.Length + o] = (lcid, OptionSets[o].Name, cases, found, differences);
            }
        });
        foreach (var (lcid, name, cases, found, differences) in outcomes)
            check(differences.Count == 0 && found > cases / 5,
                "with the pre-check a culture matcher finds exactly what the culture compare finds, for culture " + lcid + " " + name + ": "
                + found + " found in " + cases + "; " + string.Join(" | ", differences.Take(5)));
        Unverified(check);
        Cases(check);
        Contexts(check);
        KeyClasses(check);
        EveryOption(check);
        Adaptive(check);
    }

    /// <summary>Fuzzes cells and texts for one culture and option set, comparing the matcher with its pre-check against the
    /// culture compare alone. Returns the cases, how many were found, and the differences (each as cell, text and answers).</summary>
    internal static (int Cases, int Found, List<string> Differences) Differential(int lcid, int options, int iterations, int seed, SearchFold? fold = null)
    {
        var random = new Random(seed);
        var collation = new ResultCollation(lcid, 0, 1252, false, options);
        var culture = ViewSorter.Culture(collation) ?? throw new InvalidOperationException("No culture for " + lcid + ".");
        fold ??= SearchFold.Ready(lcid, culture.Options);
        var scratch = new ResultSearcher.Scratch();
        var differences = new List<string>();
        var found = 0;
        var cases = 0;
        for (var i = 0; i < iterations; i++)
        {
            var (cell, text) = i % 3 == 2 ? SentencePair(random) : SyntheticPair(random);
            if (text.Length == 0 || culture.Info.Compare(text, string.Empty, culture.Options) == 0) continue;
            cases++;
            var bytes = Encoding.UTF8.GetBytes(cell);
            // A matcher a case, so no case is judged after the matcher stopped pre-checking.
            var alone = new ResultSearcher.CultureMatcher(text, culture.Info, culture.Options, null).Matches(bytes, scratch);
            var prechecked = new ResultSearcher.CultureMatcher(text, culture.Info, culture.Options, fold).Matches(bytes, scratch);
            if (alone) found++;
            if (alone != prechecked) differences.Add(Escape(cell) + " <- " + Escape(text) + ": " + alone + " against " + prechecked);
        }
        return (cases, found, differences);
    }

    private static (string Cell, string Text) SyntheticPair(Random random)
    {
        const string plain = "abcdefghijklmnopqrstuvwxyz0123456789 .,_@";
        var count = 1 + random.Next(10);
        var tokens = new (int Group, string Text)[count];
        for (var i = 0; i < count; i++)
        {
            if (random.Next(3) == 0) tokens[i] = (-1, plain[random.Next(plain.Length)].ToString());
            else
            {
                var group = random.Next(Groups.Length);
                tokens[i] = (group, Groups[group][random.Next(Groups[group].Length)]);
            }
        }
        var cell = string.Concat(tokens.Select(token => token.Text));
        var text = new StringBuilder();
        if (random.Next(4) == 0)
        {
            for (var k = 1 + random.Next(4); k > 0; k--) text.Append(Groups[random.Next(Groups.Length)] is var g ? g[random.Next(g.Length)] : "");
            return (cell, text.ToString());
        }
        var start = random.Next(count);
        for (var i = start; i < start + 1 + random.Next(count - start); i++)
        {
            var (group, token) = tokens[i];
            if (group >= 0 && random.Next(2) == 0) text.Append(Groups[group][random.Next(Groups[group].Length)]);
            else text.Append(random.Next(6) == 0 ? token.ToUpperInvariant() : token);
            if (random.Next(12) == 0) text.Append(Groups[23][random.Next(Groups[23].Length)]);
        }
        return (cell, text.ToString());
    }

    private static (string Cell, string Text) SentencePair(Random random)
    {
        var sentence = Sentences[random.Next(Sentences.Length)];
        var start = random.Next(sentence.Length);
        var cell = sentence.Substring(start, Math.Min(sentence.Length - start, 4 + random.Next(40)));
        var from = random.Next(cell.Length);
        var piece = cell.Substring(from, Math.Max(1, Math.Min(cell.Length - from, 1 + random.Next(12))));
        var text = new StringBuilder();
        foreach (var c in piece)
        {
            var s = c.ToString();
            switch (random.Next(10))
            {
                case 0: s = s.ToUpperInvariant(); break;
                case 1: if (!char.IsSurrogate(c)) s = s.Normalize(NormalizationForm.FormD); break;
                case 2:
                    var group = Array.FindIndex(Groups, g => g.Contains(s));
                    if (group >= 0) s = Groups[group][random.Next(Groups[group].Length)];
                    break;
            }
            text.Append(s);
        }
        return (cell, text.ToString());
    }

    /// <summary>Cultures whose collation treats a letter as a pair of letters (Danish and Norwegian å as aa, Hungarian,
    /// Croatian dž) are never pre-checked: a per-character fold cannot follow them, and a long run of the differential check
    /// finds misses. A Danish fold misses here too.</summary>
    private static void Unverified(Action<bool, string> check)
    {
        int[] pairs = [1030, 1044, 1038, 1050];
        var danish = new ResultSearcher.CultureMatcher("aå", CultureInfo.GetCultureInfo(1030).CompareInfo, CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace, SearchFold.Build(1030, CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace));
        var cell = "Чaä";
        var missed = CultureInfo.GetCultureInfo(1030).CompareInfo.IndexOf(cell, "aå", CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace) >= 0
            && !danish.Matches(Encoding.UTF8.GetBytes(cell), new ResultSearcher.Scratch());
        check(pairs.All(lcid => SearchFold.For(lcid, Loosest) is null && Array.IndexOf(SearchFold.Verified, lcid) < 0) && missed,
            "cultures that treat a letter as a pair of letters (Danish, Norwegian, Hungarian, Croatian) have no fold, and a Danish one would miss a match: " + missed);
    }

    /// <summary>Named cases: what a culture compare treats alike, folded alike; scripts and characters the fold cannot vouch
    /// for, compared alone.</summary>
    private static void Cases(Action<bool, string> check)
    {
        var fold = SearchFold.Ready(1033, Loosest);
        string? F(string s) => fold.FoldText(s);
        check(F("Straße") == F("STRASSE") && F("æther") == F("AETHER") && F("é") == F("e\u0301") && F("é") == F("E")
            && F("ｓｑｌ") == F("sql") && F("٢") == F("2") && F("σοφός") == F("ΣΟΦΟΣ") && F("カ") == F("か") && F("Ёлкин") == F("ЁЛКИН"),
            "the fold maps what a culture compare treats alike to the same text: ß and ss, æ and ae, accents and decomposed letters, full-width, Arabic-Indic digits, final sigma, kana");
        check(F("กำ") is null && F("क्ष") is null && F("a😀") is null && F("ab\u00ADc") is null && F("ﬁnal") is null && F("Col·legi") is null
            && SearchFold.Ready(1041, Loosest).FoldText("サーバー") is null && F("サーヒ") is not null && F("サーヒ") == F("ｻｰﾋ") && F("ab\uFFFEc") is null && F("ab\uD800c") is null && F("abc") == "abc",
            "the fold vouches for no Thai, Indic, supplementary, ignorable, ligature or joining character, noncharacter or lone surrogate, nor in Japanese the prolonged sound mark (which it vouches for elsewhere)");
        var options = CompareOptions.IgnoreCase;
        var turkish = SearchFold.Ready(1055, options);
        var info = CultureInfo.GetCultureInfo(1055).CompareInfo;
        var scratch = new ResultSearcher.Scratch();
        bool Turkish(string cell, string text) => new ResultSearcher.CultureMatcher(text, info, options, turkish).Matches(Encoding.UTF8.GetBytes(cell), scratch);
        check(Turkish("İSTANBUL", "istanbul") && Turkish("ışık", "IŞIK") && !Turkish("ışık", "işik") == (info.IndexOf("ışık", "işik", options) < 0),
            "a Turkish column folds by Turkish rules: İ with i, ı with I, as its compare does");
        var english = new ResultSearcher.CultureMatcher("กรุณา", CultureInfo.GetCultureInfo(1033).CompareInfo, CompareOptions.IgnoreCase, SearchFold.Ready(1033, CompareOptions.IgnoreCase));
        check(english.Matches(Encoding.UTF8.GetBytes("ข้อความ กรุณาลองใหม่"), scratch) && !english.Prechecks == (fold.FoldText("กรุณา") is null),
            "a Thai text in an English column is compared without the pre-check, and found");
    }

    /// <summary>Cells where collation is not per character, each found by the culture compare under its options (but the
    /// noncharacter's, which it finds nothing in): with the pre-check the matcher finds them too. (Japanese ゞ, ゝ and ー repeat or prolong the sound before them, root joins l·l,
    /// Yiddish ligatures, 〆 is しめ, enclosed and presentation forms, Arabic madda and hamza, digraph letters, dot leaders,
    /// a mark NFC cannot compose, and a noncharacter.)</summary>
    internal static readonly (int Lcid, int Options, string Cell, string Text)[] Contextual =
    [
        (1041, 1 | 8 | 16, "いすゞ自動車", "いすず"), (1041, 1 | 8 | 16, "サーバー", "サアバア"), (1041, 1 | 8 | 16, "かゝ", "かか"),
        (1033, 1 | 2 | 8 | 16, "Col·legi", "collegi"), (1037, 1 | 8 | 16, "ייִדיש װָארט", "ווָארט"), (1033, 1 | 8 | 16, "ייִדיש װָארט", "ווָארט"),
        (1041, 1 | 8 | 16, "〆切", "しめ切"), (1033, 1 | 8 | 16, "㉊", "30"), (1025, 1 | 8 | 16, "ﻵ", "لآ"), (1025, 1 | 2 | 8 | 16, "qآ\u0655z", "qآz"),
        (1025, 1 | 2 | 8 | 16, "آ", "ءء"), (1061, 1 | 2 | 8 | 16, "ǄW", "Dƍ"), (1052, 1 | 8 | 16, "Ǌ", "nJ"),
        (1053, 1 | 2 | 8 | 16, "Ä", "Ä\u0323"), (1035, 1 | 2 | 8 | 16, "Ä", "Ä\u0323"), (1033, 1 | 8 | 16, "ab\uFFFEc", "abc"), (1033, 8 | 16, "Wait…", "․․․"), (1041, 8 | 16, "x‥y", "․․"),
    ];

    private static void Contexts(Action<bool, string> check)
    {
        var differences = new List<string>();
        var scratch = new ResultSearcher.Scratch();
        foreach (var (lcid, options, cell, text) in Contextual)
        {
            var culture = ViewSorter.Culture(new ResultCollation(lcid, 0, 1252, false, options))!.Value;
            var bytes = Encoding.UTF8.GetBytes(cell);
            var alone = new ResultSearcher.CultureMatcher(text, culture.Info, culture.Options, null).Matches(bytes, scratch);
            var prechecked = new ResultSearcher.CultureMatcher(text, culture.Info, culture.Options, SearchFold.Ready(lcid, culture.Options)).Matches(bytes, scratch);
            if (alone != !cell.Contains('\uFFFE')) differences.Add("the compare " + (alone ? "found " : "did not find ") + lcid + " " + Escape(cell) + " <- " + Escape(text));
            if (alone != prechecked) differences.Add(lcid + " " + Escape(cell) + " <- " + Escape(text) + ": " + alone + " against " + prechecked);
        }
        check(differences.Count == 0,
            "where collation depends on neighbouring characters the pre-checked matcher finds what the compare finds (every cell but the noncharacter's): " + string.Join(" | ", differences));
    }

    /// <summary>The key-class check: strings the fold vouches for that a verified culture's compare finds equal under the
    /// fold's options (the same sort key) fold to the same text, over vouched characters alone (every 16th CJK ideograph and Hangul
    /// syllable) and pairs of a sample of them, for each option set. A wider scan (every vouched character after a thousand others) runs out of tree.</summary>
    private static void KeyClasses(Action<bool, string> check)
    {
        var sample = new List<char>();
        for (var c = ' '; c <= '~'; c++) if (char.IsLetterOrDigit(c) || c is ' ' or '-' or '\'') sample.Add(c);
        sample.AddRange("ÀÄÅÆÇÐÑÖØÞßàäåæçðñöøþÿĀČĐĞİıĲĳŁŉŊŒœŘŠſŸŽơưǍǜșțΆΐΣάήίΰςόώЁЙЪЫЬЭЯёйъыьэяґҐӼӽӾӿאבךכשתاأبةتلمىي٠٢あかがっゔゕゖゝゞアカガッヴヵヶヷヺーヽヾ一數数가힣！０ＡＩＹＺａｉｙｚ～ｶｰ‐–’…․‥•†");
        sample.RemoveAll(c => !SearchFold.Vouched(c));
        var conflicts = new string?[SearchFold.Verified.Length * OptionSets.Length];
        Parallel.For(0, conflicts.Length, index =>
        {
            var lcid = SearchFold.Verified[index / OptionSets.Length];
            var culture = ViewSorter.Culture(new ResultCollation(lcid, 0, 1252, false, OptionSets[index % OptionSets.Length].Options))!.Value;
            var fold = SearchFold.Ready(lcid, culture.Options);
            var folds = new Dictionary<string, (string Fold, string Text)>();
            void Add(string text)
            {
                if (conflicts[index] is not null || fold.FoldText(text) is not { } folded) return;
                var key = Convert.ToBase64String(culture.Info.GetSortKey(text, (culture.Options & CompareOptions.IgnoreNonSpace) != 0 ? culture.Options | CompareOptions.IgnoreCase : culture.Options).KeyData);
                if (!folds.TryAdd(key, (folded, text)) && folds[key].Fold != folded)
                    conflicts[index] = lcid + " " + OptionSets[index % OptionSets.Length].Name + " " + Escape(folds[key].Text) + " and " + Escape(text);
            }
            // Every 16th CJK ideograph and Hangul syllable: the rest of those blocks cost most of the time and fold alike.
            for (var c = 0; c < 65536; c++) if (SearchFold.Vouched((char)c) && (c is < 0x4E00 or (> 0x9FFF and < 0xAC00) or > 0xD7A3 || c % 16 == 0)) Add(((char)c).ToString());
            foreach (var a in sample) foreach (var b in sample) Add(new string([a, b]));
        });
        check(conflicts.All(conflict => conflict is null),
            "strings a verified culture's compare finds equal under the fold's options fold alike: " + string.Join(" | ", conflicts.Where(conflict => conflict is not null)));
    }

    /// <summary>Under every one of the sixteen option sets a SQL collation maps to, for root (1033) and the verified cultures
    /// that tailor Latin, kana or Arabic letters, the compare finds one character of a sample in another only when their folds
    /// agree. (An out-of-tree scan runs every verified culture over every vouched character outside CJK and Hangul.) Options are not monotonic (Estonian finds
    /// Ｚ in Z case-sensitively, not case-insensitively), and a compare's IndexOf can find what its sort keys tell apart
    /// (Thai ӽ in ӿ), so this asks the compare itself.</summary>
    private static void EveryOption(Action<bool, string> check)
    {
        var sample = new List<char>();
        for (var c = 'A'; c <= 'Z'; c++) { sample.Add(c); sample.Add(char.ToLowerInvariant(c)); sample.Add((char)(c - 'A' + 0xFF21)); sample.Add((char)(c - 'A' + 0xFF41)); }
        sample.AddRange("0123456789-'ÄÅÆÐÑÖØßäåæðñöøİıĲĳŁłŒœŠšŽžơưǍǎșțΣσςЁёЙйӼӽӾӿשךاأ٢あかがゝゞアカガーヽヾｶｰ一가");
        sample.RemoveAll(c => !SearchFold.Vouched(c));
        int[] cultures = [1033, 1025, 1041, 1055, 1061, 1062, 1068];
        var misses = new string?[cultures.Length * 16];
        Parallel.For(0, misses.Length, index =>
        {
            var lcid = cultures[index / 16];
            var bits = index % 16;
            var culture = ViewSorter.Culture(new ResultCollation(lcid, 0, 1252, false, (bits & 3) | (bits & 12) << 1))!.Value;
            var fold = SearchFold.Ready(lcid, culture.Options);
            var folds = sample.Select(c => fold.FoldText(c.ToString())).ToArray();
            for (var a = 0; a < sample.Count && misses[index] is null; a++)
                for (var b = 0; b < sample.Count; b++)
                {
                    if (folds[b] is null || (folds[a] ?? "").Contains(folds[b]!, StringComparison.Ordinal)) continue;
                    if (culture.Info.IndexOf(sample[a].ToString(), sample[b].ToString(), culture.Options) < 0) continue;
                    misses[index] = lcid + " " + culture.Options + ": " + Escape(sample[b].ToString()) + " in " + Escape(sample[a].ToString());
                    break;
                }
        });
        check(misses.All(miss => miss is null),
            "under every option set the compare finds a character in another only when their folds agree: " + string.Join(" | ", misses.Where(miss => miss is not null)));
    }

    /// <summary>A text in most cells stops the pre-check after its sample; a rare one keeps it; both find what the compare
    /// finds.</summary>
    private static void Adaptive(Action<bool, string> check)
    {
        var info = CultureInfo.GetCultureInfo(1033).CompareInfo;
        var options = CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace;
        var fold = SearchFold.Ready(1033, options);
        var cells = Enumerable.Range(0, 3 * ResultSearcher.PrecheckSample).Select(i => Encoding.UTF8.GetBytes("Récord " + i + " of the ledger, état " + (i % 7))).ToArray();
        var scratch = new ResultSearcher.Scratch();
        (bool Prechecks, int Found, int Expected) Run(string text)
        {
            var matcher = new ResultSearcher.CultureMatcher(text, info, options, fold);
            var found = cells.Count(cell => matcher.Matches(cell, scratch));
            var expected = cells.Count(cell => info.IndexOf(Encoding.UTF8.GetString(cell), text, options) >= 0);
            return (matcher.Prechecks, found, expected);
        }
        var common = Run("e");
        var rare = Run("ETAT 3");
        check(!common.Prechecks && rare.Prechecks && common.Found == common.Expected && rare.Found == rare.Expected && rare.Found > 0,
            "a culture matcher stops pre-checking a text in most cells and keeps pre-checking a rare one, finding what the compare finds either way: "
            + common + ", " + rare);
        check(SearchFold.For(1033, options) is not null,
            "a verified culture's fold is ready once built, and a search asks for it without waiting");
    }

    private static string Escape(string s)
    {
        var builder = new StringBuilder();
        foreach (var c in s) builder.Append(c is >= ' ' and < '\u007F' ? c.ToString() : "\\u" + ((int)c).ToString("X4", CultureInfo.InvariantCulture));
        return builder.ToString();
    }
}
