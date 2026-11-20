namespace Varia.Backend.BigQuery;

/// <summary>
/// The backend's own GoogleSQL scanner (docs/bigquery.md, Storage Read): whether a statement orders its rows at the top
/// level, so its result is read through one Storage Read stream and keeps that order. It knows GoogleSQL's comments
/// (<c>--</c>, <c>#</c>, <c>/* */</c>), strings (quoted, triple-quoted, raw and bytes), backtick identifiers and nesting,
/// so an <c>ORDER BY</c> in a subquery, a window, an aggregate, a string or a comment does not count. A query in
/// parentheses at the statement's start (a set operation's first branch too), or a WITH clause's main query in
/// parentheses, counts as the top. Pipe syntax's
/// <c>AGGREGATE ... GROUP BY k DESC</c> orders too, so a top-level ASC or DESC counts. When unsure it answers ordered:
/// one stream is only slower, while rows appended from several streams would lose an order. Not the renderer's
/// tokenizer: the backend decides alone.
/// </summary>
internal static class GoogleSqlScanner
{
    enum Kind : byte { Word, Open, Close, Semicolon, Other }

    readonly record struct Token(Kind Kind, int Depth, int Start, int Length);

    /// <summary>Whether <paramref name="sql"/> orders its rows at the top level: an <c>ORDER BY</c> (or a pipe aggregate's
    /// ASC or DESC) outside every parenthesis, or inside parentheses that hold the statement's own query.</summary>
    public static bool HasTopLevelOrderBy(string sql)
    {
        var tokens = Tokens(sql);
        // Whether each open level holds the statement's own query: the top, and parentheses that open the statement, open
        // right inside such a parenthesis, or follow a closing one (a WITH clause's main query), whatever follows them
        // (LIMIT and pipe operators keep their input's order). Parentheses after a word (IN, FROM, AS, UNION ALL, OVER, a
        // function's name) or an operator hold something else.
        var outer = new Stack<bool>();
        var query = true;
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            switch (token.Kind)
            {
                case Kind.Open:
                    outer.Push(query);
                    query = query && (i == 0 || tokens[i - 1].Kind is Kind.Open or Kind.Close or Kind.Semicolon);
                    break;
                case Kind.Close:
                    query = outer.Count == 0 || outer.Pop();
                    break;
                case Kind.Word when query:
                    if (Is(sql, token, "ASC") || Is(sql, token, "DESC")) return true;
                    if (Is(sql, token, "ORDER") && i + 1 < tokens.Count && tokens[i + 1] is { Kind: Kind.Word } by && Is(sql, by, "BY")) return true;
                    break;
            }
        }
        return false;
    }

    static bool Is(string sql, Token token, string word) => token.Length == word.Length && string.Compare(sql, token.Start, word, 0, word.Length, StringComparison.OrdinalIgnoreCase) == 0;

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
                i = Quoted(sql, i, '`', triple: false);
                tokens.Add(new(Kind.Other, depth, start, i - start));
                continue;
            }
            if (c is '\'' or '"')
            {
                var start = i;
                i = String(sql, i);
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
                    i = String(sql, i);
                    tokens.Add(new(Kind.Other, depth, start, i - start));
                    continue;
                }
                tokens.Add(new(Kind.Word, depth, start, i - start));
                continue;
            }
            if (c == '(') { tokens.Add(new(Kind.Open, depth, i, 1)); depth++; i++; continue; }
            if (c == ')') { depth = Math.Max(0, depth - 1); tokens.Add(new(Kind.Close, depth, i, 1)); i++; continue; }
            if (c == ';') { tokens.Add(new(Kind.Semicolon, depth, i, 1)); i++; continue; }
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
    static int String(string sql, int at)
    {
        var quote = sql[at];
        var triple = at + 2 < sql.Length && sql[at + 1] == quote && sql[at + 2] == quote;
        return Quoted(sql, at, quote, triple);
    }

    static int Quoted(string sql, int at, char quote, bool triple)
    {
        var i = at + (triple ? 3 : 1);
        while (i < sql.Length)
        {
            var c = sql[i];
            // In a raw string too a backslash keeps the quote after it (r'\'' is one string).
            if (c == '\\') { i += 2; continue; }
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
