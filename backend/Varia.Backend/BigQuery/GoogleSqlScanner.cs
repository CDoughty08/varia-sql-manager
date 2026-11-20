namespace Varia.Backend.BigQuery;

/// <summary>
/// The backend's own GoogleSQL scanner (docs/bigquery.md, Storage Read): whether a statement orders its rows at the top
/// level, so its result is read through one Storage Read stream and keeps that order. It knows GoogleSQL's comments
/// (<c>--</c>, <c>#</c>, <c>/* */</c>), strings (quoted, triple-quoted, raw and bytes), backtick identifiers and nesting,
/// so an <c>ORDER BY</c> in a subquery, a window, an aggregate, a string or a comment does not count. A query wrapped
/// whole in parentheses counts its outer level as the top. Not the renderer's tokenizer: the backend decides alone.
/// </summary>
internal static class GoogleSqlScanner
{
    enum Kind : byte { Word, Open, Close, Other }

    readonly record struct Token(Kind Kind, int Depth, int Start, int Length);

    /// <summary>Whether <paramref name="sql"/> has an <c>ORDER BY</c> outside every parenthesis (or inside only the
    /// parentheses that wrap the whole statement).</summary>
    public static bool HasTopLevelOrderBy(string sql)
    {
        var tokens = Tokens(sql);
        var wrap = Wrapping(tokens);
        for (var i = 0; i + 1 < tokens.Count; i++)
        {
            var (order, by) = (tokens[i], tokens[i + 1]);
            if (order.Kind == Kind.Word && by.Kind == Kind.Word && order.Depth <= wrap && by.Depth == order.Depth
                && Is(sql, order, "ORDER") && Is(sql, by, "BY")) return true;
        }
        return false;
    }

    static bool Is(string sql, Token token, string word) => token.Length == word.Length && string.Compare(sql, token.Start, word, 0, word.Length, StringComparison.OrdinalIgnoreCase) == 0;

    /// <summary>How many leading parentheses close only at the statement's end (a trailing semicolon aside).</summary>
    static int Wrapping(List<Token> tokens)
    {
        var last = tokens.Count - 1;
        var wrap = 0;
        while (wrap <= last && tokens[wrap].Kind == Kind.Open)
        {
            // The first closing parenthesis back at this one's depth must be the last token.
            var depth = tokens[wrap].Depth;
            var closes = -1;
            for (var i = wrap + 1; i <= last; i++)
                if (tokens[i].Kind == Kind.Close && tokens[i].Depth == depth) { closes = i; break; }
            if (closes != last - wrap) break;
            wrap++;
        }
        return wrap;
    }

    /// <summary>Words and parentheses with their depth; strings, identifiers in backticks and comments are skipped, and
    /// anything else is one <see cref="Kind.Other"/> token, so two words are adjacent only when nothing came between.</summary>
    static List<Token> Tokens(string sql)
    {
        var tokens = new List<Token>();
        var depth = 0;
        var i = 0;
        var n = sql.Length;
        while (i < n)
        {
            var c = sql[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '#' || c == '-' && i + 1 < n && sql[i + 1] == '-')
            {
                while (i < n && sql[i] != '\n') i++;
                continue;
            }
            if (c == '/' && i + 1 < n && sql[i + 1] == '*')
            {
                var end = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = end < 0 ? n : end + 2;
                continue;
            }
            if (c == '`')
            {
                var start = i;
                i = Quoted(sql, i, '`', raw: false, triple: false);
                tokens.Add(new(Kind.Other, depth, start, i - start));
                continue;
            }
            if (c is '\'' or '"')
            {
                var start = i;
                i = String(sql, i, raw: false);
                tokens.Add(new(Kind.Other, depth, start, i - start));
                continue;
            }
            if (char.IsAsciiLetter(c) || c == '_')
            {
                var start = i;
                while (i < n && (char.IsAsciiLetterOrDigit(sql[i]) || sql[i] == '_')) i++;
                // A string prefix: r, b, rb or br directly before a quote.
                if (i < n && sql[i] is '\'' or '"' && i - start <= 2 && IsPrefix(sql.AsSpan(start, i - start)))
                {
                    i = String(sql, i, raw: sql.AsSpan(start, i - start).ContainsAny('r', 'R'));
                    tokens.Add(new(Kind.Other, depth, start, i - start));
                    continue;
                }
                tokens.Add(new(Kind.Word, depth, start, i - start));
                continue;
            }
            if (c == '(') { tokens.Add(new(Kind.Open, depth, i, 1)); depth++; i++; continue; }
            if (c == ')') { depth = Math.Max(0, depth - 1); tokens.Add(new(Kind.Close, depth, i, 1)); i++; continue; }
            // A statement's trailing semicolon does not separate anything Varia reads here.
            if (c == ';' && sql.AsSpan(i + 1).Trim().IsEmpty) { i = n; continue; }
            tokens.Add(new(Kind.Other, depth, i, 1));
            i++;
        }
        return tokens;
    }

    static bool IsPrefix(ReadOnlySpan<char> word) => word.Length switch
    {
        1 => word[0] is 'r' or 'R' or 'b' or 'B',
        2 => (word[0] is 'r' or 'R' && word[1] is 'b' or 'B') || (word[0] is 'b' or 'B' && word[1] is 'r' or 'R'),
        _ => false
    };

    /// <summary>The index after a string literal starting at <paramref name="at"/> (its quote).</summary>
    static int String(string sql, int at, bool raw)
    {
        var quote = sql[at];
        var triple = at + 2 < sql.Length && sql[at + 1] == quote && sql[at + 2] == quote;
        return Quoted(sql, at, quote, raw, triple);
    }

    static int Quoted(string sql, int at, char quote, bool raw, bool triple)
    {
        var i = at + (triple ? 3 : 1);
        while (i < sql.Length)
        {
            var c = sql[i];
            if (c == '\\' && !raw) { i += 2; continue; }
            if (c == quote)
            {
                if (!triple) return i + 1;
                if (i + 2 < sql.Length && sql[i + 1] == quote && sql[i + 2] == quote) return i + 3;
            }
            // A single-quoted string ends at its line (GoogleSQL refuses the rest); the scan goes on from there.
            if (!triple && quote != '`' && c == '\n') return i;
            i++;
        }
        return sql.Length;
    }
}
