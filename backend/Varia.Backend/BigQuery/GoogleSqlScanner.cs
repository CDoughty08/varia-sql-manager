namespace Varia.Backend.BigQuery;

/// <summary>A top-level GoogleSQL statement's span (in the submitted SQL text), its 1-based start line, start column and
/// end line in the submitted SQL text (matching BigQuery's <c>statistics.scriptStatistics.stackFrames</c>), its 1-based
/// editor line, its result-set class and the label Messages names it by.</summary>
internal sealed record GoogleSqlStatement(int StartOffset, int EndOffset, int StartLine, int StartColumn, int EndLine, int EditorLine, StatementClass Class, string Kind);

/// <summary>The result of scanning a GoogleSQL script for <c>#Name</c> markers and top-level statements.</summary>
internal sealed record GoogleSqlScan(IReadOnlyList<ResultMarker> Markers, IReadOnlyList<GoogleSqlStatement> Statements, bool Unbalanced);

/// <summary>
/// The backend's own GoogleSQL scanner (docs/bigquery.md, Storage Read, Named result sets): whether a statement orders its
/// rows at the top level, so its result is read through one Storage Read stream and keeps that order, and top-level
/// statement / <c>#Name</c> marker scanning for BigQuery named result sets. It knows GoogleSQL's comments
/// (<c>--</c>, <c>#</c>, <c>/* */</c>), strings (quoted, triple-quoted, raw and bytes), backtick identifiers and nesting,
/// so an <c>ORDER BY</c> or marker in a subquery, a window, an aggregate, a string or a comment does not count. A query in
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

    /// <summary>Words that make a query's rows differ from run to run, or name what only its session or script held: the
    /// clock, random values, the caller, sampling, an arbitrary row, a LIMIT (which rows it keeps may change), and
    /// statements other than one query. Temp tables are refused by the caller, which falls back only outside a session.</summary>
    static readonly HashSet<string> Unstable = new(StringComparer.OrdinalIgnoreCase)
    {
        "CURRENT_DATE", "CURRENT_DATETIME", "CURRENT_TIME", "CURRENT_TIMESTAMP", "RAND", "GENERATE_UUID", "SESSION_USER", "TABLESAMPLE",
        "ANY_VALUE", "LIMIT", "_SESSION", "DECLARE", "SET", "BEGIN", "CALL", "EXECUTE", "CREATE", "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER", "EXPORT", "LOAD"
    };

    /// <summary>Whether <paramref name="sql"/> is one query (SELECT, WITH, FROM for pipe syntax, or one in parentheses) that
    /// the scanner finds deterministic: none of <see cref="Unstable"/>'s words, no query parameter or variable (<c>@</c>), and
    /// no statement after it. When unsure it answers no: running the original query again for a sort or filter is only
    /// right when it gives the same rows (docs/bigquery.md, Sort and filter in BigQuery).</summary>
    public static bool IsDeterministicQuery(string sql)
    {
        var tokens = Tokens(sql);
        var first = tokens.FindIndex(token => token.Kind != Kind.Open);
        if (first < 0 || tokens[first].Kind != Kind.Word || !(Is(sql, tokens[first], "SELECT") || Is(sql, tokens[first], "WITH") || Is(sql, tokens[first], "FROM"))) return false;
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (token.Kind == Kind.Semicolon && tokens.Skip(i + 1).Any(next => next.Kind != Kind.Semicolon)) return false;
            if (token.Kind == Kind.Other && token.Length == 1 && sql[token.Start] == '@') return false;
            if (token.Kind == Kind.Word && Unstable.Contains(sql.Substring(token.Start, token.Length))) return false;
        }
        return true;
    }

    /// <summary>Whether <paramref name="sql"/> is one query (SELECT, WITH, FROM for pipe syntax, or one in parentheses) with no
    /// statement after it: a rerun's text when the emulator names no statement type (docs/bigquery.md, Expiry).</summary>
    public static bool IsSingleQuery(string sql)
    {
        var tokens = Tokens(sql);
        var first = tokens.FindIndex(token => token.Kind != Kind.Open);
        if (first < 0 || tokens[first].Kind != Kind.Word || !(Is(sql, tokens[first], "SELECT") || Is(sql, tokens[first], "WITH") || Is(sql, tokens[first], "FROM"))) return false;
        for (var i = 0; i < tokens.Count; i++)
            if (tokens[i].Kind == Kind.Semicolon && tokens.Skip(i + 1).Any(next => next.Kind != Kind.Semicolon)) return false;
        return true;
    }

    /// <summary>Words that start a statement able to change what a dataset lists: DDL, LOAD DATA, and the statements that run
    /// other text (EXECUTE IMMEDIATE, CALL of a procedure).</summary>
    static readonly HashSet<string> ObjectWords = new(StringComparer.OrdinalIgnoreCase) { "CREATE", "DROP", "ALTER", "UNDROP", "LOAD", "EXECUTE", "CALL" };

    /// <summary>Whether <paramref name="sql"/> holds a word (outside strings, identifiers and comments) of a statement that can
    /// change what a dataset lists (docs/object-search.md, BigQuery). When it does not, a job whose statements cannot all be read
    /// changed no object, so the index marks nothing for it.</summary>
    public static bool MayChangeObjects(string sql) => Tokens(sql).Any(token => token.Kind == Kind.Word && ObjectWords.Contains(sql.Substring(token.Start, token.Length)));

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

    enum ScanKind : byte { Word, Open, Close, Semicolon, Colon, Dot, Other }
    enum BlockKind : byte { Begin, If, Loop, While, Repeat, For, CaseStmt, CaseExpr }

    readonly record struct ScanToken(ScanKind Kind, int Start, int End, int Line, int Column);

    /// <summary>Scans only comments in <paramref name="sql"/> for <c>#Name</c> markers (skipping strings and backtick
    /// identifiers), returning every well-formed or malformed marker with its 1-based editor line.</summary>
    public static IReadOnlyList<ResultMarker> ScanMarkers(string sql, int sourceStartLine = 1) =>
        ScanLex(sql, sourceStartLine, collectTokens: false).Markers;

    /// <summary>Scans <paramref name="sql"/> for <c>#Name</c> markers and top-level GoogleSQL statements in one linear pass,
    /// tracking procedural blocks (<c>BEGIN … END</c>, <c>IF … END IF</c>, <c>LOOP</c>, <c>WHILE</c>, <c>REPEAT</c>,
    /// <c>FOR</c>, <c>CASE … END CASE</c>, <c>CREATE PROCEDURE … BEGIN … END</c>) separately from expression
    /// <c>CASE … END</c> and <c>BEGIN TRANSACTION</c>.</summary>
    public static GoogleSqlScan ScanScript(string sql, int sourceStartLine = 1)
    {
        var (markers, tokens, lexUnbalanced) = ScanLex(sql, sourceStartLine, collectTokens: true);
        var (statements, blockUnbalanced) = SplitStatements(sql, tokens!, sourceStartLine);
        return new(markers, statements, lexUnbalanced || blockUnbalanced);
    }

    static (List<ResultMarker> Markers, List<ScanToken>? Tokens, bool Unbalanced) ScanLex(string sql, int sourceStartLine, bool collectTokens)
    {
        var markers = new List<ResultMarker>();
        var tokens = collectTokens ? new List<ScanToken>() : null;
        var unbalanced = false;
        var i = 0;
        var n = sql.Length;
        var line = 1;
        var col = 1;
        while (i < n)
        {
            var c = sql[i];
            if (c is '\r' or '\n') { AdvanceChar(sql, ref i, ref line, ref col); continue; }
            if (char.IsWhiteSpace(c)) { i++; col++; continue; }
            if (c == '-' && i + 1 < n && sql[i + 1] == '-')
            {
                var start = i;
                var startLine = line;
                i += 2; col += 2;
                while (i < n && sql[i] is not ('\r' or '\n')) { i++; col++; }
                var body = sql.AsSpan(start + 2, i - (start + 2));
                if (body.IndexOf('#') >= 0 && ResultNames.TryMarker(body, out var name))
                    markers.Add(new(start, i, sourceStartLine + startLine - 1, name));
                continue;
            }
            if (c == '#')
            {
                var start = i;
                var startLine = line;
                i++; col++;
                while (i < n && sql[i] is not ('\r' or '\n')) { i++; col++; }
                var body = sql.AsSpan(start + 1, i - (start + 1));
                if (body.IndexOf('#') >= 0 && ResultNames.TryMarker(body, out var bodyName))
                    markers.Add(new(start, i, sourceStartLine + startLine - 1, bodyName));
                else
                {
                    // Bare GoogleSQL #Name="…" where '#' is both the comment introducer and marker prefix: require '='
                    // after #Name so prose like "#Name of report" or "#Name: orders" stays an ordinary comment.
                    var whole = sql.AsSpan(start, i - start);
                    if (IsBareHashMarkerCandidate(whole) && ResultNames.TryMarker(whole, out var bareName))
                        markers.Add(new(start, i, sourceStartLine + startLine - 1, bareName));
                }
                continue;
            }
            if (c == '/' && i + 1 < n && sql[i + 1] == '*')
            {
                var start = i;
                var startLine = line;
                var end = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (end < 0)
                {
                    unbalanced = true;
                    while (i < n) AdvanceChar(sql, ref i, ref line, ref col);
                    break;
                }
                var body = sql.AsSpan(start + 2, end - (start + 2));
                var stop = end + 2;
                while (i < stop) AdvanceChar(sql, ref i, ref line, ref col);
                if (body.IndexOf('#') is var hash and >= 0 && ResultNames.TryMarker(body, out var name))
                {
                    var markerLine = sourceStartLine + startLine - 1 + LineBreaks(sql.AsSpan(start, 2 + hash));
                    markers.Add(new(start, stop, markerLine, name));
                }
                continue;
            }
            if (c == '`')
            {
                var start = i;
                var startLine = line;
                var startCol = col;
                if (!AdvanceQuoted(sql, ref i, ref line, ref col, '`', triple: false)) unbalanced = true;
                tokens?.Add(new(ScanKind.Other, start, i, startLine, startCol));
                continue;
            }
            if (c is '\'' or '"')
            {
                var start = i;
                var startLine = line;
                var startCol = col;
                var triple = i + 2 < n && sql[i + 1] == c && sql[i + 2] == c;
                if (!AdvanceQuoted(sql, ref i, ref line, ref col, c, triple)) unbalanced = true;
                tokens?.Add(new(ScanKind.Other, start, i, startLine, startCol));
                continue;
            }
            if (char.IsAsciiLetter(c) || c == '_')
            {
                var start = i;
                var startLine = line;
                var startCol = col;
                while (i < n && (char.IsAsciiLetterOrDigit(sql[i]) || sql[i] == '_')) { i++; col++; }
                if (i < n && sql[i] is '\'' or '"' && i - start <= 2 && IsPrefix(sql.AsSpan(start, i - start)))
                {
                    var quote = sql[i];
                    var triple = i + 2 < n && sql[i + 1] == quote && sql[i + 2] == quote;
                    if (!AdvanceQuoted(sql, ref i, ref line, ref col, quote, triple)) unbalanced = true;
                    tokens?.Add(new(ScanKind.Other, start, i, startLine, startCol));
                    continue;
                }
                tokens?.Add(new(ScanKind.Word, start, i, startLine, startCol));
                continue;
            }
            var tokenKind = c switch
            {
                '(' => ScanKind.Open,
                ')' => ScanKind.Close,
                ';' => ScanKind.Semicolon,
                ':' => ScanKind.Colon,
                '.' => ScanKind.Dot,
                _ => ScanKind.Other
            };
            tokens?.Add(new(tokenKind, i, i + 1, line, col));
            i++; col++;
        }
        return (markers, tokens, unbalanced);
    }

    static bool IsBareHashMarkerCandidate(ReadOnlySpan<char> whole)
    {
        if (whole.Length < 6 || whole[0] != '#' || !whole[1..5].Equals("name", StringComparison.OrdinalIgnoreCase)) return false;
        var at = 5;
        while (at < whole.Length && char.IsWhiteSpace(whole[at])) at++;
        return at < whole.Length && whole[at] == '=';
    }

    static (List<GoogleSqlStatement> Statements, bool Unbalanced) SplitStatements(string sql, List<ScanToken> tokens, int sourceStartLine)
    {
        var statements = new List<GoogleSqlStatement>();
        var blocks = new Stack<BlockKind>();
        var parenDepth = 0;
        var unbalanced = false;
        var atStatementStart = true;
        var stmtStartIndex = -1;
        var stmtFirstTokenIndex = -1;
        var stmtHasLeadingOpen = false;
        var stmtIsCreateProcedure = false;

        for (var t = 0; t < tokens.Count; t++)
        {
            var token = tokens[t];
            if (stmtStartIndex < 0 && blocks.Count == 0 && parenDepth == 0 && token.Kind == ScanKind.Semicolon)
            {
                atStatementStart = true;
                continue;
            }
            var afterDot = t > 0 && tokens[t - 1].Kind == ScanKind.Dot;
            if (stmtStartIndex < 0)
            {
                stmtStartIndex = t;
                stmtFirstTokenIndex = -1;
                stmtHasLeadingOpen = false;
                stmtIsCreateProcedure = false;
            }
            switch (token.Kind)
            {
                case ScanKind.Open:
                    if (blocks.Count == 0 && parenDepth == 0 && stmtFirstTokenIndex < 0) stmtHasLeadingOpen = true;
                    parenDepth++;
                    if (stmtFirstTokenIndex >= 0) atStatementStart = false;
                    break;
                case ScanKind.Close:
                    if (parenDepth == 0) unbalanced = true;
                    else parenDepth--;
                    atStatementStart = false;
                    break;
                case ScanKind.Semicolon:
                    if (parenDepth > 0) unbalanced = true;
                    else if (blocks.Count == 0)
                    {
                        AddStatement(token.End, token.Line);
                        atStatementStart = true;
                    }
                    else
                    {
                        if (blocks.Peek() == BlockKind.CaseExpr) unbalanced = true;
                        atStatementStart = true;
                    }
                    break;
                case ScanKind.Word:
                    if (stmtFirstTokenIndex < 0 && blocks.Count == 0)
                    {
                        // Top-level label (my_label: LOOP ... END LOOP;): keep statement start at the label, advance to keyword.
                        if (parenDepth == 0 && t + 1 < tokens.Count && tokens[t + 1].Kind == ScanKind.Colon)
                        {
                            t++;
                            break;
                        }
                        stmtFirstTokenIndex = t;
                    }
                    else if (blocks.Count > 0 && parenDepth == 0 && atStatementStart && t + 1 < tokens.Count && tokens[t + 1].Kind == ScanKind.Colon)
                    {
                        // Label on an inner statement inside a procedural block.
                        t++;
                        break;
                    }
                    if (parenDepth > 0 || afterDot)
                    {
                        atStatementStart = false;
                        break;
                    }
                    if (blocks.Count == 0 && IsWord(sql, token, "PROCEDURE") && IsCreateProcedureHeader(sql, tokens, stmtFirstTokenIndex, t))
                        stmtIsCreateProcedure = true;
                    if (IsWord(sql, token, "BEGIN"))
                    {
                        var isTransaction = t + 1 < tokens.Count && tokens[t + 1].Kind == ScanKind.Word && IsWord(sql, tokens[t + 1], "TRANSACTION");
                        if (!isTransaction && (atStatementStart || stmtIsCreateProcedure && blocks.Count == 0))
                        {
                            blocks.Push(BlockKind.Begin);
                            atStatementStart = true;
                        }
                        else atStatementStart = false;
                    }
                    else if (atStatementStart && IsWord(sql, token, "IF")) { blocks.Push(BlockKind.If); atStatementStart = false; }
                    else if (atStatementStart && IsWord(sql, token, "LOOP")) { blocks.Push(BlockKind.Loop); atStatementStart = true; }
                    else if (atStatementStart && IsWord(sql, token, "WHILE")) { blocks.Push(BlockKind.While); atStatementStart = false; }
                    else if (atStatementStart && IsWord(sql, token, "REPEAT")) { blocks.Push(BlockKind.Repeat); atStatementStart = true; }
                    else if (atStatementStart && IsWord(sql, token, "FOR")) { blocks.Push(BlockKind.For); atStatementStart = false; }
                    else if (IsWord(sql, token, "CASE"))
                    {
                        blocks.Push(atStatementStart ? BlockKind.CaseStmt : BlockKind.CaseExpr);
                        atStatementStart = false;
                    }
                    else if (IsWord(sql, token, "THEN"))
                    {
                        atStatementStart = blocks.TryPeek(out var top) && top is BlockKind.If or BlockKind.CaseStmt or BlockKind.Begin;
                    }
                    else if (IsWord(sql, token, "ELSE"))
                    {
                        atStatementStart = blocks.TryPeek(out var top) && top is BlockKind.If or BlockKind.CaseStmt;
                    }
                    else if (IsWord(sql, token, "DO"))
                    {
                        atStatementStart = blocks.TryPeek(out var top) && top is BlockKind.While or BlockKind.For;
                    }
                    else if (IsWord(sql, token, "END"))
                    {
                        // A CASE expression always closes with bare END, even when followed by a non-reserved column alias (e.g. "END loop").
                        if (blocks.TryPeek(out var top) && top == BlockKind.CaseExpr)
                        {
                            blocks.Pop();
                        }
                        else if (t + 1 < tokens.Count && tokens[t + 1].Kind == ScanKind.Word && EndBlock(sql, tokens[t + 1]) is { } expected)
                        {
                            if (blocks.TryPeek(out top) && top == expected) blocks.Pop();
                            else unbalanced = true;
                            t++;
                        }
                        else if (blocks.TryPeek(out top) && top == BlockKind.Begin) blocks.Pop();
                        else unbalanced = true;
                        atStatementStart = false;
                    }
                    else atStatementStart = false;
                    break;
                default:
                    if (stmtFirstTokenIndex < 0 && blocks.Count == 0) stmtFirstTokenIndex = t;
                    atStatementStart = false;
                    break;
            }
        }

        if (parenDepth != 0 || blocks.Count != 0) unbalanced = true;
        if (stmtStartIndex >= 0)
        {
            var last = tokens[^1];
            AddStatement(last.End, last.Line + LineBreaks(sql.AsSpan(last.Start, last.End - last.Start)));
        }
        return (statements, unbalanced);

        void AddStatement(int endOffset, int endLine)
        {
            var start = tokens[stmtStartIndex];
            var (cls, kind) = ClassifyTopLevel(sql, tokens, stmtFirstTokenIndex, stmtHasLeadingOpen);
            statements.Add(new(start.Start, endOffset, start.Line, start.Column, endLine, sourceStartLine + start.Line - 1, cls, kind));
            stmtStartIndex = -1;
            stmtFirstTokenIndex = -1;
            stmtHasLeadingOpen = false;
            stmtIsCreateProcedure = false;
        }
    }

    static bool IsCreateProcedureHeader(string sql, List<ScanToken> tokens, int createIndex, int procedureIndex)
    {
        if (createIndex < 0 || procedureIndex <= createIndex || !IsWord(sql, tokens[createIndex], "CREATE")) return false;
        for (var i = createIndex + 1; i < procedureIndex; i++)
        {
            var token = tokens[i];
            if (token.Kind != ScanKind.Word || !(IsWord(sql, token, "OR") || IsWord(sql, token, "REPLACE") || IsWord(sql, token, "TEMP") || IsWord(sql, token, "TEMPORARY")))
                return false;
        }
        return true;
    }

    static BlockKind? EndBlock(string sql, ScanToken next) =>
        IsWord(sql, next, "IF") ? BlockKind.If
        : IsWord(sql, next, "LOOP") ? BlockKind.Loop
        : IsWord(sql, next, "WHILE") ? BlockKind.While
        : IsWord(sql, next, "REPEAT") ? BlockKind.Repeat
        : IsWord(sql, next, "FOR") ? BlockKind.For
        : IsWord(sql, next, "CASE") ? BlockKind.CaseStmt
        : null;

    static (StatementClass Class, string Kind) ClassifyTopLevel(string sql, List<ScanToken> tokens, int firstIndex, bool leadingOpen)
    {
        if (firstIndex < 0 || tokens[firstIndex].Kind != ScanKind.Word) return (StatementClass.Unknown, "statement");
        var first = tokens[firstIndex];
        if (leadingOpen)
            return IsWord(sql, first, "SELECT") || IsWord(sql, first, "WITH") || IsWord(sql, first, "FROM")
                ? (StatementClass.One, "SELECT") : (StatementClass.Unknown, "statement");
        if (IsWord(sql, first, "SELECT") || IsWord(sql, first, "WITH") || IsWord(sql, first, "FROM")) return (StatementClass.One, "SELECT");
        if (IsWord(sql, first, "BEGIN"))
            return firstIndex + 1 < tokens.Count && tokens[firstIndex + 1].Kind == ScanKind.Word && IsWord(sql, tokens[firstIndex + 1], "TRANSACTION")
                ? (StatementClass.None, "BEGIN TRANSACTION") : (StatementClass.Unknown, "BEGIN … END");
        if (IsWord(sql, first, "IF")) return (StatementClass.Unknown, "IF");
        if (IsWord(sql, first, "LOOP")) return (StatementClass.Unknown, "LOOP");
        if (IsWord(sql, first, "WHILE")) return (StatementClass.Unknown, "WHILE");
        if (IsWord(sql, first, "REPEAT")) return (StatementClass.Unknown, "REPEAT");
        if (IsWord(sql, first, "FOR")) return (StatementClass.Unknown, "FOR");
        if (IsWord(sql, first, "CASE")) return (StatementClass.Unknown, "CASE");
        if (IsWord(sql, first, "CALL")) return (StatementClass.Unknown, "CALL");
        if (IsWord(sql, first, "EXECUTE")) return (StatementClass.Unknown, "EXECUTE IMMEDIATE");
        if (IsWord(sql, first, "INSERT")) return (StatementClass.None, "INSERT");
        if (IsWord(sql, first, "UPDATE")) return (StatementClass.None, "UPDATE");
        if (IsWord(sql, first, "DELETE")) return (StatementClass.None, "DELETE");
        if (IsWord(sql, first, "MERGE")) return (StatementClass.None, "MERGE");
        if (IsWord(sql, first, "CREATE")) return (StatementClass.None, "CREATE");
        if (IsWord(sql, first, "DECLARE") || IsWord(sql, first, "SET") || IsWord(sql, first, "ALTER") || IsWord(sql, first, "DROP")
            || IsWord(sql, first, "UNDROP") || IsWord(sql, first, "TRUNCATE") || IsWord(sql, first, "EXPORT") || IsWord(sql, first, "LOAD")
            || IsWord(sql, first, "ASSERT") || IsWord(sql, first, "RAISE") || IsWord(sql, first, "GRANT") || IsWord(sql, first, "REVOKE")
            || IsWord(sql, first, "COMMIT") || IsWord(sql, first, "ROLLBACK"))
            return (StatementClass.None, "statement");
        return (StatementClass.Unknown, "statement");
    }

    static bool IsWord(string sql, ScanToken token, string word) =>
        token.End - token.Start == word.Length && string.Compare(sql, token.Start, word, 0, word.Length, StringComparison.OrdinalIgnoreCase) == 0;

    static void AdvanceChar(string sql, ref int i, ref int line, ref int col)
    {
        var c = sql[i];
        if (c == '\r')
        {
            line++; col = 1;
            i += i + 1 < sql.Length && sql[i + 1] == '\n' ? 2 : 1;
        }
        else if (c == '\n') { line++; col = 1; i++; }
        else { i++; col++; }
    }

    static bool AdvanceQuoted(string sql, ref int i, ref int line, ref int col, char quote, bool triple)
    {
        var n = sql.Length;
        var step = triple ? 3 : 1;
        i += step; col += step;
        while (i < n)
        {
            var c = sql[i];
            if (c == '\\')
            {
                i++; col++;
                if (i >= n) return false;
                AdvanceChar(sql, ref i, ref line, ref col);
                continue;
            }
            if (c == quote)
            {
                if (!triple) { i++; col++; return true; }
                if (i + 2 < n && sql[i + 1] == quote && sql[i + 2] == quote) { i += 3; col += 3; return true; }
            }
            if (!triple && c is '\r' or '\n') return false;
            AdvanceChar(sql, ref i, ref line, ref col);
        }
        return false;
    }

    static int LineBreaks(ReadOnlySpan<char> text)
    {
        var count = 0;
        for (var i = 0; i < text.Length; i++)
            if (text[i] == '\n' || text[i] == '\r' && (i + 1 == text.Length || text[i + 1] != '\n')) count++;
        return count;
    }
}
