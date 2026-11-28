namespace Varia.Backend.BigQuery;

/// <summary>A GoogleSQL statement that cannot execute inside a coordinated BigQuery multi-statement transaction.</summary>
internal sealed record BigQueryTransactionBlocker(int Line, string Keyword, string Message);

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

    /// <summary>Whether <paramref name="sql"/> is a single read-only <c>SELECT</c> or <c>WITH ... SELECT</c> statement
    /// (allowing parenthesized queries and trailing semicolons, rejecting multi-statement scripts and non-SELECT/WITH statements).</summary>
    public static bool IsReadOnlySelect(string sql) => InspectReadOnlySelect(sql).Allowed;

    /// <summary>Checks <paramref name="sql"/> against the Cross-Engine single-statement SELECT/WITH allowlist and returns
    /// the 1-based line and reason of the first violation, if any.</summary>
    internal static (bool Allowed, int Line, string Message) InspectReadOnlySelect(string sql)
    {
        var tokens = Tokens(sql);
        var statements = SplitStatements(tokens);
        if (statements.Count == 0)
            return (false, 1, "Cross-Engine BigQuery requires a single SELECT or WITH statement.");
        var firstStmt = statements[0];
        var firstIdx = 0;
        while (firstIdx < firstStmt.Count && firstStmt[firstIdx].Kind == Kind.Open) firstIdx++;
        if (firstIdx >= firstStmt.Count)
        {
            var openTok = firstStmt[0];
            return (false, LineOf(sql, openTok.Start), "Only a single SELECT or WITH statement is allowed in Cross-Engine BigQuery mode.");
        }
        var first = firstStmt[firstIdx];
        if (first.Kind != Kind.Word || !(Is(sql, first, "SELECT") || Is(sql, first, "WITH")))
        {
            var kw = first.Kind == Kind.Word ? sql.Substring(first.Start, first.Length).ToUpperInvariant() : sql.Substring(first.Start, first.Length);
            return (false, LineOf(sql, first.Start), $"Only a single SELECT or WITH statement is allowed in Cross-Engine BigQuery mode (found {kw}).");
        }
        if (Is(sql, first, "WITH"))
        {
            var (verb, verbIndex) = ResolveWithMain(sql, firstStmt, firstIdx);
            if (!string.Equals(verb, "SELECT", StringComparison.OrdinalIgnoreCase))
            {
                var targetTok = verbIndex >= 0 && verbIndex < firstStmt.Count ? firstStmt[verbIndex] : first;
                return (false, LineOf(sql, targetTok.Start), $"Only a single SELECT or WITH ... SELECT statement is allowed in Cross-Engine BigQuery mode (found {verb}).");
            }
        }
        if (statements.Count > 1)
        {
            var extra = statements[1][0];
            return (false, LineOf(sql, extra.Start), "Cross-Engine BigQuery supports a single SELECT or WITH statement only.");
        }
        return (true, 1, "");
    }

    static readonly HashSet<string> ScriptStarterWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "DECLARE", "SET", "BEGIN", "IF", "CASE", "LOOP", "WHILE", "FOR", "REPEAT", "ASSERT", "RAISE", "CALL", "EXECUTE", "RETURN", "LEAVE", "ITERATE", "BREAK", "CONTINUE"
    };

    /// <summary>Whether <paramref name="sql"/> is a multi-statement BigQuery script (multiple statements separated by
    /// semicolons, or a scripting control-flow/procedural statement) whose free dry-run defaults to US when no dataset or
    /// connection location is set.</summary>
    static bool IsLabelToken(string text, Token tok) =>
        tok.Kind == Kind.Word || (tok.Kind == Kind.Other && tok.Length > 0 && text[tok.Start] == '`');

    public static bool IsMultiStatementScript(string sql)
    {
        var tokens = Tokens(sql);
        var statements = SplitStatements(tokens);
        if (statements.Count > 1) return true;
        if (statements.Count == 0) return false;
        var stmt = statements[0];
        var i = 0;
        while (i < stmt.Count && stmt[i].Kind == Kind.Open) i++;
        if (i + 1 < stmt.Count && IsLabelToken(sql, stmt[i]) && IsChar(sql, stmt[i + 1], ':')) return true;
        if (i < stmt.Count && stmt[i].Kind == Kind.Word && ScriptStarterWords.Contains(sql.Substring(stmt[i].Start, stmt[i].Length))) return true;
        return false;
    }

    static readonly HashSet<string> BlockEnders = new(StringComparer.OrdinalIgnoreCase) { "IF", "WHILE", "FOR", "LOOP", "REPEAT", "CASE" };
    static readonly HashSet<string> SimpleStmtStarters = new(StringComparer.OrdinalIgnoreCase)
    {
        "SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE",
        "CREATE", "ALTER", "DROP", "UNDROP", "COMMIT", "ROLLBACK",
        "EXECUTE", "CALL", "EXPORT", "LOAD", "DECLARE", "SET", "ASSERT", "RAISE",
        "RETURN", "LEAVE", "ITERATE", "BREAK", "CONTINUE", "GRANT", "REVOKE",
        "EXPLAIN", "DESCRIBE", "ANALYZE"
    };
    static readonly HashSet<string> WhilePrevContWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "AND", "OR", "NOT", "IN", "IS", "AS", "LIKE", "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "SELECT", "FROM", "WHERE", "BY", "HAVING", "OVER", "CAST", "EXISTS"
    };
    static readonly HashSet<string> WhileNextInfixWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "AND", "OR", "NOT", "IS", "IN", "LIKE", "BETWEEN", "THEN", "ELSE", "END", "AS", "WHERE"
    };
    static readonly HashSet<string> IntervalDateParts = new(StringComparer.OrdinalIgnoreCase)
    {
        "YEAR", "YEARS", "QUARTER", "QUARTERS", "MONTH", "MONTHS", "WEEK", "WEEKS", "DAY", "DAYS",
        "HOUR", "HOURS", "MINUTE", "MINUTES", "SECOND", "SECONDS", "MILLISECOND", "MILLISECONDS", "MICROSECOND", "MICROSECONDS"
    };

    /// <summary>Finds statements in <paramref name="sql"/> that cannot run inside a coordinated BigQuery transaction:
    /// permanent DDL, explicit BEGIN/COMMIT/ROLLBACK [TRANSACTION], EXECUTE IMMEDIATE, CALL, EXPORT DATA,
    /// EXPORT TABLE METADATA, EXPORT MODEL, LOAD DATA, GRANT, and REVOKE. Allows CREATE/DROP TEMP TABLE,
    /// DROP TABLE _SESSION.*, and DML.</summary>
    public static IReadOnlyList<BigQueryTransactionBlocker> FindTransactionBlockers(string sql)
    {
        var tokens = Tokens(sql);
        var blockers = new List<BigQueryTransactionBlocker>();
        var i = 0;

        void ConsumeToSemicolon()
        {
            var depth = 0;
            while (i < tokens.Count)
            {
                var t = tokens[i];
                if (t.Kind == Kind.Open) depth++;
                else if (t.Kind == Kind.Close) { if (depth > 0) depth--; }
                else if (t.Kind == Kind.Semicolon && depth == 0) { i++; break; }
                i++;
            }
        }

        void ConsumeUntilKeyword(string stop1, string? stop2, bool consumeStop)
        {
            var depth = 0;
            var caseDepth = 0;
            while (i < tokens.Count)
            {
                var t = tokens[i];
                if (t.Kind == Kind.Open) depth++;
                else if (t.Kind == Kind.Close) { if (depth > 0) depth--; }
                else if (depth == 0 && t.Kind == Kind.Semicolon)
                {
                    // Never allow a header scan (IF/ELSEIF/WHEN/EXCEPTION/CASE) to cross a statement boundary.
                    i++;
                    break;
                }
                else if (depth == 0 && t.Kind == Kind.Word && !IsQualifiedWord(sql, tokens, i))
                {
                    if (Is(sql, t, "CASE")) caseDepth++;
                    else if (Is(sql, t, "END") && caseDepth > 0) caseDepth--;
                    else if (caseDepth == 0 && (Is(sql, t, stop1) || (stop2 is not null && Is(sql, t, stop2))))
                    {
                        if (consumeStop) i++;
                        break;
                    }
                }
                i++;
            }
        }

        void ConsumeProcedureBeginEnd()
        {
            var stack = new Stack<string>();
            var parenDepth = 0;
            var bracketDepth = 0;
            var atBlockBoundary = true;
            string? headerKind = null;
            var inSimpleStmt = false;
            var inProcHeader = false;
            var seenProcParams = false;
            while (i < tokens.Count)
            {
                var t = tokens[i];
                var top = stack.Count > 0 ? stack.Peek() : null;
                if (t.Kind == Kind.Open)
                {
                    if (atBlockBoundary && !inSimpleStmt && parenDepth == 0 && top != "exprCase")
                    {
                        inSimpleStmt = true;
                        atBlockBoundary = false;
                        headerKind = null;
                    }
                    parenDepth++;
                }
                else if (t.Kind == Kind.Close)
                {
                    if (parenDepth == 1 && inProcHeader) seenProcParams = true;
                    if (parenDepth > 0) parenDepth--;
                }
                else if (IsChar(sql, t, '[')) bracketDepth++;
                else if (IsChar(sql, t, ']')) { if (bracketDepth > 0) bracketDepth--; }
                else if (t.Kind == Kind.Semicolon && parenDepth == 0)
                {
                    inSimpleStmt = false;
                    inProcHeader = false;
                    seenProcParams = false;
                    atBlockBoundary = true;
                    headerKind = null;
                }
                else if (t.Kind == Kind.Word && !IsQualifiedWord(sql, tokens, i))
                {
                    var atBoundary = atBlockBoundary && !inSimpleStmt && parenDepth == 0 && top != "exprCase";
                    var atNestedProcBegin = inProcHeader && seenProcParams && parenDepth == 0 && top != "exprCase";
                    if (atBoundary && i + 1 < tokens.Count && IsChar(sql, tokens[i + 1], ':'))
                    {
                        i += 2;
                        continue;
                    }
                    if (Is(sql, t, "BEGIN") && (atBoundary || atNestedProcBegin))
                    {
                        var hasNext = i + 1 < tokens.Count;
                        if (!hasNext || tokens[i + 1].Kind == Kind.Semicolon
                            || (tokens[i + 1].Kind == Kind.Word && (Is(sql, tokens[i + 1], "TRANSACTION") || Is(sql, tokens[i + 1], "TRAN"))
                                && !(i + 2 < tokens.Count && IsChar(sql, tokens[i + 2], ':'))))
                        {
                            inSimpleStmt = true;
                            atBlockBoundary = false;
                            headerKind = null;
                        }
                        else
                        {
                            stack.Push("begin");
                            atBlockBoundary = true;
                            headerKind = null;
                            if (atNestedProcBegin)
                            {
                                inSimpleStmt = false;
                                inProcHeader = false;
                                seenProcParams = false;
                            }
                        }
                    }
                    else if (Is(sql, t, "CASE"))
                    {
                        if (atBoundary)
                        {
                            stack.Push("stmtCase");
                            atBlockBoundary = false;
                            headerKind = "then";
                        }
                        else stack.Push("exprCase");
                    }
                    else if (Is(sql, t, "END"))
                    {
                        var nextIsWord = i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Word;
                        var afterNextEnds = i + 2 >= tokens.Count || tokens[i + 2].Kind == Kind.Semicolon;
                        var afterNextHasLabel = i + 2 < tokens.Count && IsLabelToken(sql, tokens[i + 2])
                            && (i + 3 >= tokens.Count || tokens[i + 3].Kind == Kind.Semicolon);
                        if (top == "exprCase") stack.Pop();
                        else if (top == "stmtCase" && parenDepth == 0)
                        {
                            stack.Pop();
                            atBlockBoundary = false;
                            headerKind = null;
                            if (nextIsWord && Is(sql, tokens[i + 1], "CASE") && afterNextEnds) i++;
                        }
                        else if (parenDepth == 0)
                        {
                            if (nextIsWord && BlockEnders.Contains(sql.Substring(tokens[i + 1].Start, tokens[i + 1].Length)) && (afterNextEnds || afterNextHasLabel))
                            {
                                atBlockBoundary = false;
                                headerKind = null;
                                i += afterNextHasLabel ? 3 : 2;
                                continue;
                            }
                            if (stack.Count > 0) stack.Pop();
                            atBlockBoundary = false;
                            headerKind = null;
                            if (i + 1 < tokens.Count && IsLabelToken(sql, tokens[i + 1]) && afterNextEnds) i++;
                        }
                        if (stack.Count == 0)
                        {
                            i++;
                            if (i < tokens.Count && tokens[i].Kind == Kind.Semicolon) i++;
                            break;
                        }
                    }
                    else if (atBoundary)
                    {
                        if (Is(sql, t, "IF") || Is(sql, t, "ELSEIF") || Is(sql, t, "WHEN") || Is(sql, t, "EXCEPTION"))
                        {
                            atBlockBoundary = false;
                            headerKind = "then";
                        }
                        else if (Is(sql, t, "WHILE") || Is(sql, t, "FOR"))
                        {
                            atBlockBoundary = false;
                            headerKind = "do";
                        }
                        else if (Is(sql, t, "UNTIL"))
                        {
                            atBlockBoundary = false;
                            headerKind = "until";
                        }
                        else if (Is(sql, t, "ELSE") || Is(sql, t, "LOOP") || Is(sql, t, "REPEAT"))
                        {
                            atBlockBoundary = true;
                            headerKind = null;
                        }
                        else if (SimpleStmtStarters.Contains(sql.Substring(t.Start, t.Length)))
                        {
                            inSimpleStmt = true;
                            atBlockBoundary = false;
                            headerKind = null;
                            if (Is(sql, t, "CREATE") && IsCreateProcedureAt(sql, tokens, i))
                            {
                                inProcHeader = true;
                                seenProcParams = false;
                            }
                        }
                    }
                    else if (!inSimpleStmt && parenDepth == 0 && bracketDepth == 0 && top != "exprCase")
                    {
                        if (headerKind == "then" && Is(sql, t, "THEN"))
                        {
                            atBlockBoundary = true;
                            headerKind = null;
                        }
                        else if (headerKind == "do" && Is(sql, t, "DO") && IsWhileDoTerminator(sql, tokens, i, rejectAfterWhileOrFor: true))
                        {
                            atBlockBoundary = true;
                            headerKind = null;
                        }
                    }
                }
                i++;
            }
        }

        while (i < tokens.Count)
        {
            var cur = tokens[i];
            if (cur.Kind == Kind.Semicolon) { i++; continue; }
            if (cur.Kind != Kind.Word)
            {
                if (cur.Kind == Kind.Open) ConsumeToSemicolon();
                else i++;
                continue;
            }
            // Labeled block or loop (`lbl: BEGIN ...`, `lbl: LOOP ...`).
            if (i + 1 < tokens.Count && IsChar(sql, tokens[i + 1], ':'))
            {
                i += 2;
                continue;
            }
            if (Is(sql, cur, "EXCEPTION"))
            {
                i++;
                ConsumeUntilKeyword("THEN", null, consumeStop: true);
                continue;
            }
            if (Is(sql, cur, "IF") || Is(sql, cur, "ELSEIF"))
            {
                i++;
                ConsumeUntilKeyword("THEN", null, consumeStop: true);
                continue;
            }
            if (Is(sql, cur, "ELSE") || Is(sql, cur, "LOOP") || Is(sql, cur, "REPEAT"))
            {
                i++;
                continue;
            }
            if (Is(sql, cur, "FOR"))
            {
                i++;
                if (i < tokens.Count && tokens[i].Kind == Kind.Word) i++;
                var depth = 0;
                while (i < tokens.Count)
                {
                    var t = tokens[i];
                    if (t.Kind == Kind.Open) depth++;
                    else if (t.Kind == Kind.Close) { if (depth > 0) depth--; }
                    else if (depth == 0 && t.Kind == Kind.Word && !IsQualifiedWord(sql, tokens, i) && Is(sql, t, "IN")) { i++; break; }
                    i++;
                }
                ConsumeUntilKeyword("DO", null, consumeStop: true);
                continue;
            }
            if (Is(sql, cur, "WHILE"))
            {
                i++;
                var depth = 0;
                var bracketDepth = 0;
                var caseDepth = 0;
                var sawExpr = false;
                while (i < tokens.Count)
                {
                    var t = tokens[i];
                    if (t.Kind == Kind.Open) depth++;
                    else if (t.Kind == Kind.Close) { if (depth > 0) depth--; }
                    else if (IsChar(sql, t, '[')) bracketDepth++;
                    else if (IsChar(sql, t, ']')) { if (bracketDepth > 0) bracketDepth--; }
                    else if (depth == 0 && bracketDepth == 0 && t.Kind == Kind.Semicolon) { i++; break; }
                    else if (depth == 0 && bracketDepth == 0 && t.Kind == Kind.Word && !IsQualifiedWord(sql, tokens, i))
                    {
                        if (Is(sql, t, "CASE")) caseDepth++;
                        else if (Is(sql, t, "END") && caseDepth > 0) caseDepth--;
                        else if (caseDepth == 0 && Is(sql, t, "DO") && sawExpr && IsWhileDoTerminator(sql, tokens, i, rejectAfterWhileOrFor: false)) { i++; break; }
                    }
                    sawExpr = true;
                    i++;
                }
                continue;
            }
            if (Is(sql, cur, "UNTIL"))
            {
                i++;
                var depth = 0;
                var caseDepth = 0;
                while (i < tokens.Count)
                {
                    var t = tokens[i];
                    if (t.Kind == Kind.Open) depth++;
                    else if (t.Kind == Kind.Close) { if (depth > 0) depth--; }
                    else if (depth == 0)
                    {
                        if (t.Kind == Kind.Semicolon) { i++; break; }
                        if (t.Kind == Kind.Word && !IsQualifiedWord(sql, tokens, i))
                        {
                            if (Is(sql, t, "CASE")) caseDepth++;
                            else if (Is(sql, t, "END") && caseDepth > 0) caseDepth--;
                            else if (caseDepth == 0 && Is(sql, t, "END"))
                            {
                                i++;
                                if (i < tokens.Count && tokens[i].Kind == Kind.Word && Is(sql, tokens[i], "REPEAT")) i++;
                                if (i < tokens.Count && IsLabelToken(sql, tokens[i]) && (i + 1 >= tokens.Count || tokens[i + 1].Kind == Kind.Semicolon)) i++;
                                if (i < tokens.Count && tokens[i].Kind == Kind.Semicolon) i++;
                                break;
                            }
                        }
                    }
                    i++;
                }
                continue;
            }
            if (Is(sql, cur, "CASE"))
            {
                i++;
                ConsumeUntilKeyword("WHEN", "ELSE", consumeStop: false);
                continue;
            }
            if (Is(sql, cur, "WHEN"))
            {
                i++;
                ConsumeUntilKeyword("THEN", null, consumeStop: true);
                continue;
            }
            if (Is(sql, cur, "END"))
            {
                if (i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Word && BlockEnders.Contains(sql.Substring(tokens[i + 1].Start, tokens[i + 1].Length))) i += 2;
                else i++;
                if (i < tokens.Count && IsLabelToken(sql, tokens[i]) && (i + 1 >= tokens.Count || tokens[i + 1].Kind == Kind.Semicolon)) i++;
                if (i < tokens.Count && tokens[i].Kind == Kind.Semicolon) i++;
                continue;
            }
            if (Is(sql, cur, "BEGIN"))
            {
                var hasNext = i + 1 < tokens.Count;
                var nextIsTx = hasNext && tokens[i + 1].Kind == Kind.Word
                    && (Is(sql, tokens[i + 1], "TRANSACTION") || Is(sql, tokens[i + 1], "TRAN"))
                    && !(i + 2 < tokens.Count && IsChar(sql, tokens[i + 2], ':'));
                if (nextIsTx || !hasNext || tokens[i + 1].Kind == Kind.Semicolon)
                {
                    var keyword = nextIsTx ? "BEGIN TRANSACTION" : "BEGIN";
                    blockers.Add(new(LineOf(sql, cur.Start), keyword, $"Explicit {keyword} is not allowed in BigQuery Transaction mode (Varia manages the transaction automatically)."));
                    ConsumeToSemicolon();
                    continue;
                }
                i++;
                continue;
            }

            var line = LineOf(sql, cur.Start);
            var mainUpper = sql.Substring(cur.Start, cur.Length).ToUpperInvariant();
            if (mainUpper == "WITH")
            {
                var (verb, verbIndex) = ResolveWithMain(sql, tokens, i);
                mainUpper = verb;
                if (verbIndex > i) i = verbIndex;
            }

            if (mainUpper is "COMMIT" or "ROLLBACK")
            {
                var hasTx = i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Word && (Is(sql, tokens[i + 1], "TRANSACTION") || Is(sql, tokens[i + 1], "TRAN"));
                var keyword = hasTx ? mainUpper + " TRANSACTION" : mainUpper;
                blockers.Add(new(line, keyword, $"Explicit {keyword} is not allowed in BigQuery Transaction mode (Varia coordinates commit and rollback across targets)."));
                ConsumeToSemicolon();
                continue;
            }

            if (mainUpper == "EXECUTE" && i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Word && Is(sql, tokens[i + 1], "IMMEDIATE"))
            {
                blockers.Add(new(line, "EXECUTE IMMEDIATE", "EXECUTE IMMEDIATE is not allowed in BigQuery Transaction mode because dynamic SQL can bypass transaction safety checks."));
                ConsumeToSemicolon();
                continue;
            }

            if (mainUpper == "CALL")
            {
                blockers.Add(new(line, "CALL", "CALL is not allowed in BigQuery Transaction mode because stored procedures can run permanent DDL or commit transactions."));
                ConsumeToSemicolon();
                continue;
            }

            if (mainUpper == "EXPORT" && i + 2 < tokens.Count && tokens[i + 1].Kind == Kind.Word && Is(sql, tokens[i + 1], "TABLE")
                && tokens[i + 2].Kind == Kind.Word && Is(sql, tokens[i + 2], "METADATA"))
            {
                blockers.Add(new(line, "EXPORT TABLE METADATA", "EXPORT TABLE METADATA cannot be rolled back and is not allowed in BigQuery Transaction mode."));
                ConsumeToSemicolon();
                continue;
            }

            if ((mainUpper == "EXPORT" && i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Word && (Is(sql, tokens[i + 1], "DATA") || Is(sql, tokens[i + 1], "MODEL")))
                || (mainUpper == "LOAD" && i + 1 < tokens.Count && tokens[i + 1].Kind == Kind.Word && Is(sql, tokens[i + 1], "DATA")))
            {
                var keyword = mainUpper + " " + sql.Substring(tokens[i + 1].Start, tokens[i + 1].Length).ToUpperInvariant();
                blockers.Add(new(line, keyword, $"{keyword} cannot be rolled back and is not allowed in BigQuery Transaction mode."));
                ConsumeToSemicolon();
                continue;
            }

            if (mainUpper is "GRANT" or "REVOKE")
            {
                blockers.Add(new(line, mainUpper, $"{mainUpper} is not allowed in BigQuery Transaction mode."));
                ConsumeToSemicolon();
                continue;
            }

            if (mainUpper is "CREATE" or "ALTER" or "DROP" or "UNDROP")
            {
                var probe = i + 1;
                var isTemp = false;
                if (probe + 1 < tokens.Count && tokens[probe].Kind == Kind.Word && Is(sql, tokens[probe], "OR")
                    && tokens[probe + 1].Kind == Kind.Word && Is(sql, tokens[probe + 1], "REPLACE"))
                    probe += 2;
                if (probe < tokens.Count && tokens[probe].Kind == Kind.Word && (Is(sql, tokens[probe], "TEMP") || Is(sql, tokens[probe], "TEMPORARY")))
                {
                    isTemp = true;
                    probe++;
                }
                if (probe < tokens.Count && tokens[probe].Kind == Kind.Word && (Is(sql, tokens[probe], "PUBLIC") || Is(sql, tokens[probe], "PRIVATE")))
                    probe++;
                var objWord = probe < tokens.Count && tokens[probe].Kind == Kind.Word ? sql.Substring(tokens[probe].Start, tokens[probe].Length).ToUpperInvariant() : "";
                var secondObj = probe + 1 < tokens.Count && tokens[probe + 1].Kind == Kind.Word ? sql.Substring(tokens[probe + 1].Start, tokens[probe + 1].Length).ToUpperInvariant() : "";
                var isTableFunction = IsTableFunction(sql, tokens, probe, mainUpper, objWord, secondObj);
                var kindLabel = objWord == "MATERIALIZED" && secondObj == "VIEW" ? "MATERIALIZED VIEW"
                    : objWord == "EXTERNAL" && secondObj == "TABLE" ? "EXTERNAL TABLE"
                    : isTableFunction ? "TABLE FUNCTION"
                    : objWord == "AGGREGATE" && secondObj == "FUNCTION" ? "AGGREGATE FUNCTION"
                    : objWord;
                var keyword = string.IsNullOrEmpty(kindLabel) ? mainUpper : $"{mainUpper}{(isTemp ? " TEMP" : "")} {kindLabel}";

                var allowed = false;
                if (mainUpper == "CREATE" && isTemp && kindLabel == "TABLE")
                {
                    allowed = true;
                }
                else if (mainUpper == "DROP" && kindLabel == "TABLE")
                {
                    var targetIdx = probe + 1;
                    if (targetIdx + 1 < tokens.Count && tokens[targetIdx].Kind == Kind.Word && Is(sql, tokens[targetIdx], "IF")
                        && tokens[targetIdx + 1].Kind == Kind.Word && Is(sql, tokens[targetIdx + 1], "EXISTS"))
                        targetIdx += 2;
                    var isSession = IsSessionTarget(sql, tokens, targetIdx);
                    allowed = isTemp || isSession;
                }

                if (!allowed)
                {
                    blockers.Add(new(line, keyword, $"{keyword} is not supported inside a BigQuery multi-statement transaction."));
                }

                if (mainUpper == "CREATE" && objWord == "PROCEDURE")
                {
                    var depth = 0;
                    var seenParams = false;
                    while (i < tokens.Count)
                    {
                        var t = tokens[i];
                        if (t.Kind == Kind.Open) depth++;
                        else if (t.Kind == Kind.Close)
                        {
                            if (depth == 1) seenParams = true;
                            if (depth > 0) depth--;
                        }
                        else if (depth == 0)
                        {
                            if (t.Kind == Kind.Semicolon) { i++; break; }
                            if (t.Kind == Kind.Word && Is(sql, t, "BEGIN") && seenParams && !IsQualifiedWord(sql, tokens, i))
                            {
                                ConsumeProcedureBeginEnd();
                                break;
                            }
                        }
                        i++;
                    }
                }
                else
                {
                    ConsumeToSemicolon();
                }
                continue;
            }

            ConsumeToSemicolon();
        }
        return blockers;
    }

    static bool IsTableFunction(string sql, List<Token> tokens, int probe, string mainUpper, string objWord, string secondObj)
    {
        if (objWord != "TABLE" || secondObj != "FUNCTION") return false;
        if (probe + 2 >= tokens.Count) return false;
        var third = tokens[probe + 2];
        if (third.Kind is Kind.Semicolon or Kind.Open) return false;
        if (mainUpper == "DROP") return true;
        if (third.Kind != Kind.Word) return true;
        if (Is(sql, third, "AS") || Is(sql, third, "LIKE") || Is(sql, third, "DEFAULT") || Is(sql, third, "FOR")) return false;
        var hasFourth = probe + 3 < tokens.Count;
        if (Is(sql, third, "CLONE") || Is(sql, third, "COPY") || Is(sql, third, "PARTITION") || Is(sql, third, "CLUSTER"))
            return hasFourth && (tokens[probe + 3].Kind == Kind.Open || IsChar(sql, tokens[probe + 3], '.'));
        if (Is(sql, third, "OPTIONS"))
        {
            if (hasFourth && IsChar(sql, tokens[probe + 3], '.')) return true;
            if (!hasFourth || tokens[probe + 3].Kind != Kind.Open) return true;
            var depth = 1;
            var p = probe + 4;
            while (p < tokens.Count && depth > 0)
            {
                var tok = tokens[p];
                if (tok.Kind == Kind.Open) depth++;
                else if (tok.Kind == Kind.Close) depth--;
                else if (depth == 1 && IsChar(sql, tok, '=')) return false;
                p++;
            }
            return true;
        }
        return true;
    }

    static bool IsSessionTarget(string sql, List<Token> tokens, int targetIdx)
    {
        if (targetIdx >= tokens.Count) return false;
        var tok = tokens[targetIdx];
        var raw = sql.Substring(tok.Start, tok.Length).Replace("`", "", StringComparison.Ordinal);
        if (string.Equals(raw, "_SESSION", StringComparison.OrdinalIgnoreCase)
            && targetIdx + 1 < tokens.Count && IsChar(sql, tokens[targetIdx + 1], '.'))
            return true;
        return raw.StartsWith("_SESSION.", StringComparison.OrdinalIgnoreCase);
    }

    static bool IsCreateProcedureAt(string sql, List<Token> tokens, int idx)
    {
        var p = idx + 1;
        if (p + 1 < tokens.Count && tokens[p].Kind == Kind.Word && Is(sql, tokens[p], "OR")
            && tokens[p + 1].Kind == Kind.Word && Is(sql, tokens[p + 1], "REPLACE"))
            p += 2;
        if (p < tokens.Count && tokens[p].Kind == Kind.Word && (Is(sql, tokens[p], "TEMP") || Is(sql, tokens[p], "TEMPORARY"))) p++;
        if (p < tokens.Count && tokens[p].Kind == Kind.Word && (Is(sql, tokens[p], "PUBLIC") || Is(sql, tokens[p], "PRIVATE"))) p++;
        return p < tokens.Count && tokens[p].Kind == Kind.Word && Is(sql, tokens[p], "PROCEDURE");
    }

    static bool IsQualifiedWord(string sql, List<Token> tokens, int idx) =>
        idx > 0 && (IsChar(sql, tokens[idx - 1], '.') || IsChar(sql, tokens[idx - 1], '@'));

    static bool IsWhileDoTerminator(string sql, List<Token> tokens, int idx, bool rejectAfterWhileOrFor)
    {
        var hasPrev = idx > 0;
        var hasNext = idx + 1 < tokens.Count;
        var prevIsWord = hasPrev && tokens[idx - 1].Kind == Kind.Word && !IsQualifiedWord(sql, tokens, idx - 1);
        var prevUpper = prevIsWord ? sql.Substring(tokens[idx - 1].Start, tokens[idx - 1].Length).ToUpperInvariant() : "";
        var prevCont = hasPrev && (
            (prevIsWord && ((rejectAfterWhileOrFor && prevUpper is "WHILE" or "FOR") || WhilePrevContWords.Contains(prevUpper)))
            || tokens[idx - 1].Kind == Kind.Open
            || (tokens[idx - 1].Kind == Kind.Other && tokens[idx - 1].Length == 1 && sql[tokens[idx - 1].Start] is ',' or '=' or '<' or '>' or '!' or '+' or '-' or '*' or '/' or '%' or '|' or '&' or '^' or '~' or '.' or '[' or '@')
        );
        var nextCont = hasNext && (
            (tokens[idx + 1].Kind == Kind.Word && WhileNextInfixWords.Contains(sql.Substring(tokens[idx + 1].Start, tokens[idx + 1].Length)))
            || (tokens[idx + 1].Kind == Kind.Other && tokens[idx + 1].Length == 1 && sql[tokens[idx + 1].Start] is ',' or '=' or '<' or '>' or '!' or '+' or '-' or '*' or '/' or '%' or '|' or '&' or '^' or '.' or '[' or ']')
        );
        var isIntervalExpr = prevIsWord && prevUpper == "INTERVAL" && hasNext && tokens[idx + 1].Kind == Kind.Word
            && IntervalDateParts.Contains(sql.Substring(tokens[idx + 1].Start, tokens[idx + 1].Length));
        return !prevCont && !nextCont && !isIntervalExpr;
    }

    static List<List<Token>> SplitStatements(List<Token> tokens)
    {
        var statements = new List<List<Token>>();
        var current = new List<Token>();
        foreach (var token in tokens)
        {
            if (token.Kind == Kind.Semicolon && token.Depth == 0)
            {
                if (current.Count > 0)
                {
                    statements.Add(current);
                    current = [];
                }
            }
            else
            {
                current.Add(token);
            }
        }
        if (current.Count > 0) statements.Add(current);
        return statements;
    }

    static (string Verb, int Index) ResolveWithMain(string sql, List<Token> tokens, int startIdx)
    {
        var cursor = startIdx;
        while (cursor < tokens.Count)
        {
            var scan = cursor + 1;
            if (scan < tokens.Count && tokens[scan].Kind == Kind.Word && Is(sql, tokens[scan], "RECURSIVE")) scan++;
            var depth = 0;
            var seenCteBody = false;
            var prevZeroUpper = "";
            var prevZeroChar = '\0';
            var prevZeroIsWord = false;
            var descended = false;
            while (scan < tokens.Count)
            {
                var t = tokens[scan];
                if (t.Kind == Kind.Open)
                {
                    if (depth == 0 && seenCteBody && prevZeroChar != ',' && prevZeroUpper != "AS" && !prevZeroIsWord)
                    {
                        var peek = scan + 1;
                        while (peek < tokens.Count && tokens[peek].Kind == Kind.Open) peek++;
                        if (peek < tokens.Count)
                        {
                            var inner = tokens[peek];
                            if (inner.Kind == Kind.Word && Is(sql, inner, "SELECT")) return ("SELECT", peek);
                            if (inner.Kind == Kind.Word && Is(sql, inner, "WITH"))
                            {
                                cursor = peek;
                                descended = true;
                                break;
                            }
                            return (inner.Kind == Kind.Word ? sql.Substring(inner.Start, inner.Length).ToUpperInvariant() : sql.Substring(inner.Start, inner.Length), peek);
                        }
                    }
                    depth++;
                }
                else if (t.Kind == Kind.Close)
                {
                    if (depth > 0)
                    {
                        depth--;
                        if (depth == 0)
                        {
                            seenCteBody = true;
                            prevZeroChar = ')';
                            prevZeroUpper = "";
                            prevZeroIsWord = false;
                        }
                    }
                }
                else if (depth == 0 && !IsQualifiedWord(sql, tokens, scan))
                {
                    if (t.Kind == Kind.Semicolon) break;
                    if (seenCteBody && prevZeroChar != ',' && !IsChar(sql, t, ','))
                    {
                        var word = t.Kind == Kind.Word ? sql.Substring(t.Start, t.Length).ToUpperInvariant() : sql.Substring(t.Start, t.Length);
                        return (word, scan);
                    }
                    // Skip CTE name before AS (e.g. `WITH update AS (...) SELECT ...`).
                    if (scan + 2 < tokens.Count && tokens[scan + 1].Kind == Kind.Word && Is(sql, tokens[scan + 1], "AS") && tokens[scan + 2].Kind == Kind.Open)
                    {
                        scan += 2;
                        prevZeroUpper = "AS";
                        prevZeroChar = '\0';
                        prevZeroIsWord = true;
                        continue;
                    }
                    if (t.Kind == Kind.Word && (Is(sql, t, "SELECT") || Is(sql, t, "INSERT") || Is(sql, t, "UPDATE") || Is(sql, t, "DELETE") || Is(sql, t, "MERGE")))
                        return (sql.Substring(t.Start, t.Length).ToUpperInvariant(), scan);
                    prevZeroIsWord = t.Kind == Kind.Word;
                    prevZeroUpper = prevZeroIsWord ? sql.Substring(t.Start, t.Length).ToUpperInvariant() : "";
                    prevZeroChar = t.Kind == Kind.Other && t.Length == 1 ? sql[t.Start] : '\0';
                }
                scan++;
            }
            if (!descended) break;
        }
        return ("WITH", startIdx);
    }

    static bool IsChar(string sql, Token token, char c) => token.Kind == Kind.Other && token.Length == 1 && sql[token.Start] == c;

    static int LineOf(string sql, int offset)
    {
        var line = 1;
        var limit = Math.Min(offset, sql.Length);
        for (var i = 0; i < limit; i++)
        {
            if (sql[i] == '\n') line++;
            else if (sql[i] == '\r' && (i + 1 >= limit || sql[i + 1] != '\n')) line++;
        }
        return line;
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
                while (i < n && sql[i] != '\n' && sql[i] != '\r') i++;
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
            if (c == '0' && i + 1 < n && sql[i + 1] is 'x' or 'X' && i + 2 < n && char.IsAsciiHexDigit(sql[i + 2]))
            {
                var start = i;
                i += 2;
                while (i < n && char.IsAsciiHexDigit(sql[i])) i++;
                tokens.Add(new(Kind.Other, depth, start, i - start));
                continue;
            }
            if (char.IsAsciiDigit(c) || (c == '.' && i + 1 < n && char.IsAsciiDigit(sql[i + 1])))
            {
                // Tokenize GoogleSQL numeric literals (including trailing-decimal floats like `1.`) as a single Kind.Other token
                // so trailing `.` is never mistaken for a struct-member dot before THEN / DO / WHEN / END.
                var start = i;
                if (c == '.')
                {
                    i++;
                    while (i < n && char.IsAsciiDigit(sql[i])) i++;
                }
                else
                {
                    while (i < n && char.IsAsciiDigit(sql[i])) i++;
                    if (i < n && sql[i] == '.')
                    {
                        i++;
                        while (i < n && char.IsAsciiDigit(sql[i])) i++;
                    }
                }
                if (i < n && sql[i] is 'e' or 'E')
                {
                    var exp = i + 1;
                    if (exp < n && sql[exp] is '+' or '-') exp++;
                    if (exp < n && char.IsAsciiDigit(sql[exp]))
                    {
                        i = exp;
                        while (i < n && char.IsAsciiDigit(sql[i])) i++;
                    }
                }
                tokens.Add(new(Kind.Other, depth, start, i - start));
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
            if (!triple && quote != '`' && c is '\n' or '\r') return i;
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
