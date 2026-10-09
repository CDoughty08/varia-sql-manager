namespace Varia.Backend.Scripting;

/// <summary>SMO writes "/****** Object:  Table [dbo].[T]    Script Date: … ******/" with names unescaped, so a name
/// containing */ could end the comment early and run the rest of the name as SQL; one with a line break could also move
/// SMO's own ending onto a line of its own, behind a -- comment the name supplied. A header passes only when it is one
/// line ending in ******/, with no other */ and no /* inside, and every "Script Date:" in the text belongs to exactly
/// one such line. Otherwise the target is scripted again without headers (spec C7). SMO 181 already writes "?" for
/// a name containing */; the guard does not rely on it.</summary>
internal static class HeaderGuard
{
    public const string Opening = "/****** Object:";
    private const string Closing = "******/";
    private const string Date = "Script Date:";
    public const string Warning = "Descriptive headers were left out because an object name contains /*, */ or a line break.";

    public static bool Safe(string text)
    {
        var dated = 0;
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
            dated++;
            start = at + line.Length;
        }
        return Count(text, Date) == dated;
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
