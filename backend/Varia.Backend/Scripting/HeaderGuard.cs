using System.Text.RegularExpressions;

namespace Varia.Backend.Scripting;

/// <summary>SMO writes "/****** Object:  Table [dbo].[T]    Script Date: … ******/" with names unescaped, so a name
/// containing */ could end the comment early and run the rest of the name as SQL; one with a line break could also move
/// SMO's own ending onto a line of its own, behind a -- comment the name supplied. A header passes only when it is one
/// line ending in ******/, with no other */ and no /* inside, and every line that ends as SMO ends a header ("Script
/// Date:" … "******/") is such a line. Otherwise the target is scripted again without headers (spec C7), and the script
/// keeps its headers only when they are all that differs (<see cref="Aligned"/>): a definition's own text may hold such
/// lines, in any shape. SMO 181 already writes "?" for a name containing */; the guard does not rely on it. A script
/// without headers is not guarded: SMO writes none then, and what remains is the definitions' stored text.
/// SMO also writes comments as batches of their own, with headers on or off: <see cref="Unresolved"/>, which
/// SmoScriptRunner leaves out, and any other that <see cref="Closed(IReadOnlyList{string}, Func{Module, bool})"/>
/// refuses when a name breaks it.</summary>
internal static partial class HeaderGuard
{
    public const string Opening = "/****** Object:";
    private const string Closing = "******/";
    private const string Date = "Script Date:";
    public const string Warning = "Descriptive headers were left out because an object name or definition would break them (it contains /*, */ or a line break).";

    /// <summary>The batch SMO 181 writes for an object Generate script for dependent objects found referenced but could
    /// not resolve (ScriptMaker.ScriptCreateUnresolvedEntity): the object's URN as is, where only apostrophes are
    /// doubled, so a name in it can end the comment early or break it over lines.</summary>
    public static string Unresolved(string urn) => "/****** Cannot script Unresolved Entities : " + urn + " ******/";

    /// <summary>Whether a batch SMO writes as a comment of its own is still one: a batch that opens with "/****** " and
    /// ends with " ******/", as SMO's comment batches do, must be a single comment on a single line that closes only
    /// at its end, with no other comment delimiter in it. Any other batch passes.</summary>
    public static bool Closed(string batch)
    {
        var text = batch.TrimEnd();
        if (!text.StartsWith("/****** ", StringComparison.Ordinal) || !text.EndsWith(" " + Closing, StringComparison.Ordinal)) return true;
        return text.IndexOfAny(['\r', '\n', '\u2028', '\u2029']) < 0 && text.IndexOf("*/", 2, StringComparison.Ordinal) == text.Length - 2
            && text.IndexOf("/*", 2, StringComparison.Ordinal) < 0;
    }

    /// <summary>Whether every batch passes <see cref="Closed(string)"/>, or is the definition of a module the script
    /// creates or alters: a module's stored text, which SMO keeps as is, may start and end with comments shaped like
    /// SMO's. Such a batch passes only when its first statement creates or alters a module <paramref name="scripted"/>
    /// accepts, the query window would not split it (that statement must be alone in its batch, so everything after it
    /// is the module's own body), and no other batch creates or alters that module: SMO writes each definition once.</summary>
    public static bool Closed(IReadOnlyList<string> batches, Func<Module, bool> scripted)
    {
        for (var index = 0; index < batches.Count; index++)
        {
            if (Closed(batches[index])) continue;
            if (Defines(batches[index]) is not { } module || !scripted(module) || SmoScriptRunner.Splits(batches[index])) return false;
            for (var other = 0; other < batches.Count; other++)
                if (other != index && Mentions(batches[other], module.Statement)) return false;
        }
        return true;
    }

    [GeneratedRegex(@"(?:CREATE|ALTER)\s+(?:OR\s+ALTER\s+)?(?:PROCEDURE|PROC|FUNCTION|VIEW|TRIGGER|DEFAULT|RULE)\s+(?<statement>(?:\[(?:[^\]]|\]\])*\]\.)?\[(?:[^\]]|\]\])*\])"
        + @"(?<stub>\s+AS'(?!'))?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ModuleMention();

    /// <summary>Whether a batch creates or alters the module SMO names so anywhere in it: as a statement, or inside the
    /// sp_executesql string Check for object existence wraps a definition in, where apostrophes are doubled. The empty
    /// stub SMO creates there before a procedure's definition (as an ALTER) is not one.</summary>
    private static bool Mentions(string batch, string statement)
    {
        var quoted = statement.Replace("'", "''", StringComparison.Ordinal);
        foreach (Match match in ModuleMention().Matches(batch))
            if (!match.Groups["stub"].Success && match.Groups["statement"].Value is var named && (named == statement || named == quoted)) return true;
        return false;
    }

    /// <summary>A module's CREATE, ALTER or CREATE OR ALTER as SMO writes it: the statement keyword (PROCEDURE for
    /// PROC), the name as written (bracketed, schema-qualified or not), the name itself, and the table or view after ON.</summary>
    public sealed record Module(string Keyword, string Statement, string Name, string? On);

    /// <summary>The statement keyword SMO writes for a module of a URN type, or null for a type with no T-SQL definition.</summary>
    public static string? Keyword(string urnType) => urnType switch
    {
        "StoredProcedure" => "PROCEDURE",
        "UserDefinedFunction" => "FUNCTION",
        "View" => "VIEW",
        "Trigger" or "DdlTrigger" => "TRIGGER",
        "Default" => "DEFAULT",
        "Rule" => "RULE",
        _ => null
    };

    [GeneratedRegex(@"\G(?:CREATE\s+OR\s+ALTER|CREATE|ALTER)\s+(?<keyword>PROCEDURE|PROC|FUNCTION|VIEW|TRIGGER|DEFAULT|RULE)\s+(?<statement>(?:\[(?:[^\]]|\]\])*\]\.)?\[(?<name>(?:[^\]]|\]\])*)\])"
        + @"(?:\s+ON\s+(?:\[(?:[^\]]|\]\])*\]\.)?\[(?<on>(?:[^\]]|\]\])*)\])?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ModuleStatement();

    /// <summary>The module a batch creates or alters: its first statement after leading comments and white space, with
    /// bracketed names as SMO writes them. Null for any other batch, or one whose leading comment does not close.</summary>
    public static Module? Defines(string batch)
    {
        if (Code(batch) is not (>= 0 and var at) || ModuleStatement().Match(batch, at) is not { Success: true } match) return null;
        var keyword = match.Groups["keyword"].Value.ToUpperInvariant();
        static string Unquote(string name) => name.Replace("]]", "]", StringComparison.Ordinal);
        return new(keyword == "PROC" ? "PROCEDURE" : keyword, match.Groups["statement"].Value, Unquote(match.Groups["name"].Value),
            match.Groups["on"].Success ? Unquote(match.Groups["on"].Value) : null);
    }

    /// <summary>Where a batch's code starts: after white space, -- comments and /* */ comments, which nest in T-SQL. −1
    /// when there is no code or a comment does not end.</summary>
    private static int Code(string text)
    {
        var at = 0;
        while (at < text.Length)
        {
            if (char.IsWhiteSpace(text[at])) at++;
            else if (text.AsSpan(at).StartsWith("--"))
            {
                var end = text.IndexOfAny(['\r', '\n'], at);
                if (end < 0) return -1;
                at = end;
            }
            else if (text.AsSpan(at).StartsWith("/*"))
            {
                var depth = 0;
                do
                {
                    if (at + 1 >= text.Length) return -1;
                    if (text[at] == '/' && text[at + 1] == '*') { depth++; at += 2; }
                    else if (text[at] == '*' && text[at + 1] == '/') { depth--; at += 2; }
                    else at++;
                } while (depth > 0);
            }
            else return at;
        }
        return -1;
    }

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
