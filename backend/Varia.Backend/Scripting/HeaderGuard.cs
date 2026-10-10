namespace Varia.Backend.Scripting;

/// <summary>SMO writes "/****** Object:  Table [dbo].[T]    Script Date: … ******/" with names unescaped, so a name
/// containing */ could end the comment early and run the rest of the name as SQL; one with a line break could also move
/// SMO's own ending onto a line of its own, behind a -- comment the name supplied. A header passes only when it is one
/// line ending in ******/, with no other */ and no /* inside, and every line that ends as SMO ends a header ("Script
/// Date:" … "******/") is such a line. Otherwise the target is scripted again without headers (spec C7). SMO 181 already
/// writes "?" for a name containing */; the guard does not rely on it.</summary>
internal static class HeaderGuard
{
    public const string Opening = "/****** Object:";
    private const string Closing = "******/";
    private const string Date = "Script Date:";
    public const string Warning = "Descriptive headers were left out because an object name or definition would break them (it contains /*, */ or a line break).";

    public static bool Safe(string text)
    {
        var headers = 0;
        for (var start = 0; start < text.Length;)
        {
            var at = text.IndexOf(Opening, start, StringComparison.Ordinal);
            if (at < 0) break;
            start = at + Opening.Length;
            // Only a header at the start of a line is SMO's; anything else is part of a module's own text.
            if (at > 0 && text[at - 1] != '\n') continue;
            var end = text.IndexOfAny(['\r', '\n'], at);
            var line = text.AsSpan(at, (end < 0 ? text.Length : end) - at);
            if (!line.EndsWith(Closing) || line.IndexOf("*/") != line.Length - 2 || line[2..].IndexOf("/*") >= 0 || line.IndexOfAny('\u2028', '\u2029') >= 0
                || Count(line, Date) != 1) return false;
            headers++;
            start = at + line.Length;
        }
        // A module's own comment may mention "Script Date:"; only a line ending as SMO ends a header must be one.
        return Dated(text) == headers;
    }

    /// <summary>Lines ending as SMO ends a header: "Script Date:" followed, at the end of the line, by ******/. A lone CR
    /// or a line separator ends a line too.</summary>
    public static int Dated(string text)
    {
        var count = 0;
        foreach (var range in text.AsSpan().SplitAny("\r\n\u2028\u2029"))
        {
            var line = text.AsSpan(range);
            if (line.EndsWith(Closing) && line.IndexOf(Date) >= 0) count++;
        }
        return count;
    }

    private static int Count(ReadOnlySpan<char> text, string value)
    {
        var count = 0;
        for (var at = text.IndexOf(value, StringComparison.Ordinal); at >= 0; at = text.IndexOf(value, StringComparison.Ordinal))
        {
            count++;
            text = text[(at + value.Length)..];
        }
        return count;
    }
}
