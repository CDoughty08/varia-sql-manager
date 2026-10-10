namespace Varia.Backend.Scripting;

/// <summary>SMO writes "/****** Object:  Table [dbo].[T]    Script Date: … ******/" with names unescaped, so a name
/// containing */ could end the comment early and run the rest of the name as SQL; one with a line break could also move
/// SMO's own ending onto a line of its own, behind a -- comment the name supplied. A header passes only when it is one
/// line ending in ******/, with no other */ and no /* inside, and every line that ends as SMO ends a header ("Script
/// Date:" … "******/") is such a line. Otherwise the target is scripted again without headers (spec C7), and the script
/// keeps its headers only when they are all that differs (<see cref="Aligned"/>): a definition's own text may hold such
/// lines. SMO 181 already writes "?" for a name containing */; the guard does not rely on it.</summary>
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
            if (!Header(line)) return false;
            headers++;
            start = at + line.Length;
        }
        // A module's own comment may mention "Script Date:"; only a line ending as SMO ends a header must be one.
        return Dated(text) == headers;
    }

    /// <summary>One whole header on one line: it opens and closes the comment, holds no other comment delimiter or line
    /// separator, and has one "Script Date:".</summary>
    private static bool Header(ReadOnlySpan<char> line) => line.StartsWith(Opening) && line.EndsWith(Closing) && line.IndexOf("*/") == line.Length - 2
        && line[2..].IndexOf("/*") < 0 && line.IndexOfAny('\u2028', '\u2029') < 0 && Count(line, Date) == 1;

    /// <summary>The batch after a leading header line and its line break ("" for a header alone), or null when the batch
    /// does not start with a whole header.</summary>
    private static string? AfterHeader(string batch)
    {
        if (!batch.StartsWith(Opening, StringComparison.Ordinal)) return null;
        var end = batch.IndexOfAny(['\r', '\n']);
        if (!Header(batch.AsSpan(0, end < 0 ? batch.Length : end))) return null;
        if (end < 0) return "";
        if (batch[end] == '\r')
        {
            if (end + 1 >= batch.Length || batch[end + 1] != '\n') return null;
            end++;
        }
        return batch[(end + 1)..];
    }

    /// <summary>Whether the batches SMO wrote with headers are the ones it wrote without them plus whole header lines and
    /// nothing else. Every line the guard could not tell from a header is then a definition's own text, which the script
    /// without headers holds as well, and each header is an inert comment of its own.</summary>
    public static bool Aligned(IReadOnlyList<string> headed, IReadOnlyList<string> plain)
    {
        var next = 0;
        foreach (var batch in headed)
        {
            if (next < plain.Count && batch == plain[next]) { next++; continue; }
            var rest = AfterHeader(batch);
            if (rest is null) return false;
            if (next < plain.Count && rest == plain[next]) next++;
            else if (!string.IsNullOrWhiteSpace(rest)) return false;
        }
        return next == plain.Count;
    }

    /// <summary>A batch SMO wrote without headers may start with a definition's own text, an old header comment included,
    /// but not with a header that is split over lines or ends early: SMO 181 writes none there, so one would be SMO's.</summary>
    public static bool Unheaded(string batch) => !batch.StartsWith(Opening, StringComparison.Ordinal) || AfterHeader(batch) is not null;

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
