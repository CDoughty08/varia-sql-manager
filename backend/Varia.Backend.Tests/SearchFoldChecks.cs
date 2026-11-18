using System.Globalization;
using System.Text;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The search fold (SearchFold) and the culture matcher's pre-check: with the pre-check, a culture matcher finds
/// exactly what the culture compare alone finds, for every verified culture and every option set, over fuzzed text built
/// from characters a culture compare treats alike (ß and ss, æ and ae, final sigma, kana, full-width and Arabic-Indic
/// digits, ignorable characters, decomposed letters) and fictional multilingual text; cultures that join letters into one
/// are not verified; a cell the fold cannot vouch for goes to the compare; the pre-check stops when most cells pass it.</summary>
internal static class SearchFoldChecks
{
    // SqlCompareOptions: IgnoreCase 1, IgnoreNonSpace 2, IgnoreKanaType 8, IgnoreWidth 16.
    private static readonly (string Name, int Options)[] OptionSets = [("CI_AI", 1 | 2 | 8 | 16), ("CI_AS", 1 | 8 | 16), ("CS_AS", 8 | 16)];

    /// <summary>Characters and strings a culture compare may treat alike, in groups.</summary>
    internal static readonly string[][] Groups =
    [
        ["ss", "ß", "ẞ", "SS"], ["ae", "æ", "Æ", "AE"], ["oe", "œ", "Œ"], ["fi", "ﬁ"], ["fl", "ﬂ"], ["ffi", "ﬃ"], ["ij", "ĳ", "Ĳ"],
        ["a", "á", "à", "â", "ä", "å", "ａ", "Ａ", "A", "á", "ā"], ["e", "é", "è", "ê", "ë", "é", "ｅ", "E", "ę"],
        ["o", "ø", "ö", "ó", "Ø", "ö"], ["l", "ł", "Ł", "L"], ["d", "đ", "ð", "Đ"], ["i", "ı", "İ", "I", "ｉ", "í"],
        ["c", "ç", "C", "č"], ["n", "ñ", "N", "ñ"], ["k", "K", "K"], ["σ", "ς", "Σ"], ["か", "カ", "ｶ", "が", "が"],
        ["2", "٢", "２", "²", "②", "₂"], ["1", "١", "１", "¹", "①"], ["th", "þ", "Þ"], ["й", "й", "Й"], ["u", "ü", "ú", "ü", "U"],
        ["", "­", "​", "‌", "‍", "⁠", "﻿", "́"], [" ", " ", "　", " "],
        ["-", "–", "‐", "−"], ["A", "𝐀", "𝔸"], ["dz", "ǆ", "Ǆ", "dž"], ["°c", "℃"], ["1/2", "½"], ["'", "’"],
        ["g", "ğ", "G"], ["s", "ş", "ś", "š", "S"], ["z", "ž", "Z"], ["r", "ř", "R"], ["t", "ť", "T"], ["y", "ý", "ÿ", "Y"],
        ["ч", "Ч"], ["aa", "å", "Å", "AA"], ["cs", "CS"], ["ch", "CH"], ["ll", "LL"], ["lj", "ǉ"], ["ö", "ő", "ø"], ["ё", "ё", "е"],
        ["ア", "あ", "ｱ"], ["한", "한"], ["数", "數"], ["ㄱ", "ᄀ"], ["ก", "เก", "กำ"], ["क", "क्ष", "कि"], ["😀", "👍🏽", "👨‍👩‍👧"],
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
        Adaptive(check);
    }

    /// <summary>Fuzzes cells and texts for one culture and option set, comparing the matcher with its pre-check against the
    /// culture compare alone. Returns the cases, how many were found, and the differences (each as cell, text and answers).</summary>
    internal static (int Cases, int Found, List<string> Differences) Differential(int lcid, int options, int iterations, int seed, SearchFold? fold = null)
    {
        var random = new Random(seed);
        fold ??= SearchFold.Ready(lcid);
        var collation = new ResultCollation(lcid, 0, 1252, false, options);
        var culture = ViewSorter.Culture(collation) ?? throw new InvalidOperationException("No culture for " + lcid + ".");
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
        var danish = new ResultSearcher.CultureMatcher("aå", CultureInfo.GetCultureInfo(1030).CompareInfo, CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace, SearchFold.Build(1030));
        var cell = "Чaä";
        var missed = CultureInfo.GetCultureInfo(1030).CompareInfo.IndexOf(cell, "aå", CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace) >= 0
            && !danish.Matches(Encoding.UTF8.GetBytes(cell), new ResultSearcher.Scratch());
        check(pairs.All(lcid => SearchFold.For(lcid) is null && Array.IndexOf(SearchFold.Verified, lcid) < 0) && missed,
            "cultures that treat a letter as a pair of letters (Danish, Norwegian, Hungarian, Croatian) have no fold, and a Danish one would miss a match: " + missed);
    }

    /// <summary>Named cases: what a culture compare treats alike, folded alike; scripts and characters the fold cannot vouch
    /// for, compared alone.</summary>
    private static void Cases(Action<bool, string> check)
    {
        var fold = SearchFold.Ready(1033);
        string? F(string s) => fold.FoldText(s);
        check(F("Straße") == F("STRASSE") && F("æther") == F("AETHER") && F("ﬁnal") == F("final") && F("é") == F("é") && F("é") == F("E")
            && F("ｓｑｌ") == F("sql") && F("٢") == F("2") && F("σοφός") == F("ΣΟΦΟΣ") && F("ab­c") == F("abc") && F("カ") == F("か"),
            "the fold maps what a culture compare treats alike to the same text: ß and ss, æ and ae, ligatures, accents and decomposed letters, full-width, Arabic-Indic digits, final sigma, soft hyphens, kana");
        check(F("กำ") is null && F("क्ष") is null && F("a😀") is null && F("­") is null && F("abc") == "abc",
            "the fold vouches for no Thai, Indic or supplementary character, and a text of only ignorable characters folds to nothing");
        var turkish = SearchFold.Ready(1055);
        var options = CompareOptions.IgnoreCase;
        var info = CultureInfo.GetCultureInfo(1055).CompareInfo;
        var scratch = new ResultSearcher.Scratch();
        bool Turkish(string cell, string text) => new ResultSearcher.CultureMatcher(text, info, options, turkish).Matches(Encoding.UTF8.GetBytes(cell), scratch);
        check(Turkish("İSTANBUL", "istanbul") && Turkish("ışık", "IŞIK") && !Turkish("ışık", "işik") == (info.IndexOf("ışık", "işik", options) < 0),
            "a Turkish column folds by Turkish rules: İ with i, ı with I, as its compare does");
        var english = new ResultSearcher.CultureMatcher("กรุณา", CultureInfo.GetCultureInfo(1033).CompareInfo, CompareOptions.IgnoreCase, fold);
        check(english.Matches(Encoding.UTF8.GetBytes("ข้อความ กรุณาลองใหม่"), scratch) && !english.Prechecks == (fold.FoldText("กรุณา") is null),
            "a Thai text in an English column is compared without the pre-check, and found");
    }

    /// <summary>A text in most cells stops the pre-check after its sample; a rare one keeps it; both find what the compare
    /// finds.</summary>
    private static void Adaptive(Action<bool, string> check)
    {
        var fold = SearchFold.Ready(1033);
        var info = CultureInfo.GetCultureInfo(1033).CompareInfo;
        var options = CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace;
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
        check(SearchFold.For(1033) is not null,
            "a verified culture's fold is ready once built, and a search asks for it without waiting");
    }

    private static string Escape(string s)
    {
        var builder = new StringBuilder();
        foreach (var c in s) builder.Append(c is >= ' ' and < '\u007F' ? c.ToString() : "\\u" + ((int)c).ToString("X4", CultureInfo.InvariantCulture));
        return builder.ToString();
    }
}
