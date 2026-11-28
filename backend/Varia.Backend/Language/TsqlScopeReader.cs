using System.Text;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace Varia.Backend.Language;

/// <summary>What kind of T-SQL completion site the caret is at.</summary>
internal enum TsqlSiteKind
{
    None,
    StatementStart,
    UseDatabase,
    Object,
    AfterFromTable,
    JoinCondition,
    Member,
    Expression,
    InsertColumnList,
    CastType,
    DatePart,
    SystemGlobal,
    LocalVariable
}

/// <summary>Hints what object kinds belong at an Object site.</summary>
internal enum TsqlObjectHint
{
    TableOrView,
    Procedure,
    TableValuedFunction,
    Any
}

/// <summary>A column defined in script-local SQL (#temp, @table, CTE, derived table, PIVOT/UNPIVOT, OPENJSON).</summary>
internal sealed record LocalColumn(string Name, string? TypeText = null, bool? Nullable = null);

/// <summary>A script-local table (#temp, ##global_temp) or batch-local @table variable.</summary>
internal sealed record LocalTable(
    string Name,
    bool IsTableVariable,
    IReadOnlyList<LocalColumn> Columns,
    IReadOnlyList<TsqlSourceRef>? SelectIntoSources = null,
    bool SelectIntoStar = false,
    TsqlObjectRef? TableTypeRef = null);

/// <summary>A batch-local @scalar variable or procedure/function parameter.</summary>
internal sealed record LocalVariable(string Name, string? TypeText);

/// <summary>A catalog object reference (database, schema, name).</summary>
internal sealed record TsqlObjectRef(string? Database, string? Schema, string Name);

/// <summary>A source visible in the caret's query scope: catalog table/view/TVF, CTE, #temp, @table, derived table, PIVOT/UNPIVOT, or OUTPUT virtual table.</summary>
internal sealed record TsqlSourceRef(
    string ExposureName,
    string RawQualifier,
    bool HasExplicitAlias,
    string Kind, // "table", "cte", "temp", "tableVar", "derived", "output", "pivot", "unpivot", "openjson"
    TsqlObjectRef? ObjectRef = null,
    IReadOnlyList<LocalColumn>? InlineColumns = null,
    bool HasStar = false,
    IReadOnlyList<TsqlSourceRef>? StarSources = null,
    IReadOnlyList<string>? ExcludedColumns = null,
    bool IsOuter = false);

/// <summary>A CTE visible in the current statement.</summary>
internal sealed record TsqlCteInfo(string Name, IReadOnlyList<LocalColumn> Columns, bool HasStar, IReadOnlyList<TsqlSourceRef> StarSources);

/// <summary>Full in-process reading of a T-SQL document at a completion caret.</summary>
internal sealed record TsqlCompletionContext(
    TsqlSiteKind Site,
    TsqlObjectHint ObjectHint,
    LanguageRange ReplacementRange,
    string Typed,
    bool Quoted,
    bool ParenAhead,
    string? ActiveDatabase,
    IReadOnlyList<string> QualifierParts,
    bool MemberIsObjectPosition,
    IReadOnlyList<TsqlSourceRef> Sources,
    IReadOnlyList<TsqlSourceRef> OuterSources,
    TsqlSourceRef? JoinRightSource,
    IReadOnlyList<TsqlSourceRef> JoinLeftSources,
    TsqlSourceRef? InsertTarget,
    IReadOnlySet<string> OutputAliases,
    IReadOnlyList<TsqlCteInfo> Ctes,
    IReadOnlyDictionary<string, LocalTable> TempTables,
    IReadOnlyDictionary<string, LocalTable> TableVariables,
    IReadOnlyDictionary<string, LocalVariable> ScalarVariables,
    bool InOutputClause,
    bool InOrderBy);

/// <summary>Full in-process reading of a T-SQL document at a hover position.</summary>
internal sealed record TsqlHoverContext(
    LanguageRange Range,
    IReadOnlyList<string> Parts,
    int HoveredSegmentIndex,
    bool IsObjectPosition,
    bool IsCall,
    bool IsTypePosition,
    bool IsUseDatabase,
    string? ActiveDatabase,
    IReadOnlyList<TsqlSourceRef> Sources,
    IReadOnlyList<TsqlSourceRef> OuterSources,
    IReadOnlyList<TsqlCteInfo> Ctes,
    IReadOnlyDictionary<string, LocalTable> TempTables,
    IReadOnlyDictionary<string, LocalTable> TableVariables,
    IReadOnlyDictionary<string, LocalVariable> ScalarVariables);

/// <summary>In-process ScriptDom (<see cref="TSql180Parser"/>) T-SQL scope and caret-site reader.
/// Combines bounded ScriptDom AST analysis (with minimal cursor repair for incomplete mid-typing SQL)
/// and ScriptDom token-stream scanning so completion and hover work cleanly in &lt; 5 ms on both
/// complete and partially typed scripts without logging SQL text or risking stack overflow.</summary>
internal static class TsqlScopeReader
{
    private const string CursorMarker = "__varia_tsql_caret_7a3c__";
    private const int MaxScriptTokens = 1_000_000;
    private const int MaxLocalTables = 256;
    private const int MaxLocalVariables = 512;

    private static readonly HashSet<TSqlTokenType> StatementStarters =
    [
        TSqlTokenType.Select, TSqlTokenType.Insert, TSqlTokenType.Update, TSqlTokenType.Delete,
        TSqlTokenType.Merge, TSqlTokenType.With, TSqlTokenType.Declare, TSqlTokenType.Set,
        TSqlTokenType.Exec, TSqlTokenType.Execute, TSqlTokenType.If, TSqlTokenType.While,
        TSqlTokenType.Begin, TSqlTokenType.Create, TSqlTokenType.Alter, TSqlTokenType.Drop,
        TSqlTokenType.Truncate, TSqlTokenType.Use, TSqlTokenType.Print, TSqlTokenType.Return
    ];

    internal static TsqlCompletionContext ReadCompletion(string text, LanguagePosition position, string? defaultDatabase)
    {
        var cursor = SqlToolsLanguageService.CompletionOffset(text, position);
        var emptyRange = new LanguageRange(position, position);
        if (cursor < 0 || text.Length > SqlToolsLanguageService.MaxTextCharacters)
            return EmptyCompletion(emptyRange, defaultDatabase);

        var parser = new TSql180Parser(initialQuotedIdentifiers: true);
        var tokens = parser.GetTokenStream(new StringReader(text), out _);
        if (tokens.Count == 0 || tokens.Count > MaxScriptTokens)
            return EmptyCompletion(emptyRange, defaultDatabase);

        // 1. Check if caret is inside a comment or string literal.
        if (IsInsideCommentOrString(tokens, cursor))
            return EmptyCompletion(emptyRange, defaultDatabase);

        // 2. Locate batch bounds (GO) and extract script-wide USE / #temp and batch-local @table / @scalar.
        var (batchFrom, batchTo) = FindBatchBounds(tokens, text.Length, cursor);
        var activeDatabase = defaultDatabase;
        var tempTables = new Dictionary<string, LocalTable>(StringComparer.OrdinalIgnoreCase);
        var tableVars = new Dictionary<string, LocalTable>(StringComparer.OrdinalIgnoreCase);
        var scalarVars = new Dictionary<string, LocalVariable>(StringComparer.OrdinalIgnoreCase);

        CollectScriptAndBatchLocals(tokens, text, cursor, batchFrom, ref activeDatabase, tempTables, tableVars, scalarVars);

        // 3. Determine replacement span, typed text, quoting, and token index immediately before the word.
        var (replaceStart, replaceEnd, typed, quoted, beforeWordIdx, parenAhead) = ReadWordAtCaret(text, tokens, cursor);
        var replaceRange = new LanguageRange(DefinitionNames.PositionOf(text, replaceStart), DefinitionNames.PositionOf(text, replaceEnd));

        // 4. Locate statement bounds within the current batch.
        var (stmtFrom, stmtTo) = FindStatementBounds(tokens, batchFrom, batchTo, cursor);

        // 5. Parse statement scope (AST with smart cursor repair, falling back to token scan).
        var stmtScope = ParseStatementScope(text, tokens, stmtFrom, stmtTo, replaceStart, replaceEnd, cursor, tempTables, tableVars);

        // 6. Classify the caret site from token context + statement scope.
        var (site, objHint, qualifierParts, memberIsObject, insertTarget, inOrderBy, inOutput) =
            ClassifySite(text, tokens, stmtFrom, stmtTo, replaceStart, typed, quoted, beforeWordIdx, stmtScope);

        // If cursor is in a DML OUTPUT clause, expose inserted / deleted virtual tables with DML target's schema.
        var sources = stmtScope.Sources;
        if (inOutput && stmtScope.DmlTarget is { } dmlTarget)
        {
            var augmented = new List<TsqlSourceRef>(sources.Count + 2);
            augmented.Add(dmlTarget with { ExposureName = "inserted", RawQualifier = "inserted", HasExplicitAlias = true, Kind = "output" });
            augmented.Add(dmlTarget with { ExposureName = "deleted", RawQualifier = "deleted", HasExplicitAlias = true, Kind = "output" });
            augmented.AddRange(sources);
            sources = augmented;
        }

        // For JoinCondition, find the joined right source and left sources if AST didn't already split them.
        var joinRight = stmtScope.JoinRightSource;
        var joinLeft = stmtScope.JoinLeftSources;
        if (site == TsqlSiteKind.JoinCondition && joinRight is null && sources.Count >= 2)
        {
            joinRight = sources[^1];
            joinLeft = [.. sources.Take(sources.Count - 1)];
        }

        return new TsqlCompletionContext(
            site,
            objHint,
            replaceRange,
            typed,
            quoted,
            parenAhead,
            activeDatabase,
            qualifierParts,
            memberIsObject,
            sources,
            stmtScope.OuterSources,
            joinRight,
            joinLeft,
            insertTarget ?? stmtScope.InsertTarget,
            inOrderBy ? stmtScope.OutputAliases : new HashSet<string>(StringComparer.Ordinal),
            stmtScope.Ctes,
            tempTables,
            tableVars,
            scalarVars,
            inOutput,
            inOrderBy);
    }

    internal static TsqlHoverContext? ReadHover(string text, LanguagePosition position, string? defaultDatabase)
    {
        var cursor = SqlToolsLanguageService.CompletionOffset(text, position);
        if (cursor < 0 || text.Length > SqlToolsLanguageService.MaxTextCharacters) return null;

        var parser = new TSql180Parser(initialQuotedIdentifiers: true);
        var tokens = parser.GetTokenStream(new StringReader(text), out _);
        if (tokens.Count == 0 || tokens.Count > MaxScriptTokens) return null;

        if (IsInsideCommentOrString(tokens, cursor)) return null;

        var at = FindHoverToken(tokens, cursor);
        if (at < 0) return null;

        var token = tokens[at];
        var (batchFrom, batchTo) = FindBatchBounds(tokens, text.Length, cursor);
        var activeDatabase = defaultDatabase;
        var tempTables = new Dictionary<string, LocalTable>(StringComparer.OrdinalIgnoreCase);
        var tableVars = new Dictionary<string, LocalTable>(StringComparer.OrdinalIgnoreCase);
        var scalarVars = new Dictionary<string, LocalVariable>(StringComparer.OrdinalIgnoreCase);
        CollectScriptAndBatchLocals(tokens, text, cursor, batchFrom, ref activeDatabase, tempTables, tableVars, scalarVars);

        // Single-token hover for @var, @@global, or built-in type/function keywords (like CAST, CONVERT, LEFT, RIGHT, REPLACE, COALESCE, NULLIF, INT, etc.).
        if (token.TokenType == TSqlTokenType.Variable)
        {
            var range = TokenRange(text, token);
            return new TsqlHoverContext(range, [token.Text], 0, false, false, false, false, activeDatabase, [], [], [], tempTables, tableVars, scalarVars);
        }

        // Collect dotted chain around `at`.
        bool Trivia(int idx) => idx >= 0 && idx < tokens.Count && IsTrivia(tokens[idx]);
        int Back(int idx) { do idx--; while (Trivia(idx)); return idx; }
        int Ahead(int idx) { do idx++; while (Trivia(idx)); return idx; }
        bool IsType(int idx, TSqlTokenType t) => idx >= 0 && idx < tokens.Count && tokens[idx].TokenType == t;
        bool IsIdent(int idx) => idx >= 0 && idx < tokens.Count && IsIdentifierOrHoverable(tokens[idx]);

        var before = new List<int?>();
        var after = new List<int?>();
        int first = at, last = at;

        for (var cur = at; ;)
        {
            var dot = Back(cur);
            if (!IsType(dot, TSqlTokenType.Dot)) break;
            var prev = Back(dot);
            if (IsIdent(prev)) before.Insert(0, prev);
            else if (IsType(prev, TSqlTokenType.Dot) && IsIdent(Back(prev))) { prev = Back(prev); before.InsertRange(0, [prev, null]); }
            else break;
            cur = first = prev;
            if (before.Count > 6) return null;
        }
        for (var cur = at; ;)
        {
            var dot = Ahead(cur);
            if (!IsType(dot, TSqlTokenType.Dot)) break;
            var next = Ahead(dot);
            if (IsIdent(next)) after.Add(next);
            else if (IsType(next, TSqlTokenType.Dot) && IsIdent(Ahead(next))) { next = Ahead(next); after.AddRange([null, next]); }
            else break;
            cur = last = next;
            if (after.Count > 6) return null;
        }

        var parts = before.Append<int?>(at).Concat(after)
            .Select(idx => idx is { } i ? TsqlCatalog.Unquote(tokens[i].Text) : "")
            .ToList();
        if (parts.Count is 0 or > 4) return null;

        var hoveredIdx = before.Count;
        var hoverTokenRange = TokenRange(text, token);
        var isCall = IsType(Ahead(last), TSqlTokenType.LeftParenthesis);
        var prevNonTrivia = Back(first);
        var isUseDb = prevNonTrivia >= 0 && tokens[prevNonTrivia].TokenType == TSqlTokenType.Use;
        var isTypePos = IsTypePositionBefore(tokens, prevNonTrivia);
        var isObjectPos = isUseDb || IsObjectPositionBefore(tokens, prevNonTrivia, batchFrom);

        var (stmtFrom, stmtTo) = FindStatementBounds(tokens, batchFrom, batchTo, cursor);
        var stmtScope = ParseStatementScope(text, tokens, stmtFrom, stmtTo, token.Offset, token.Offset + token.Text.Length, cursor, tempTables, tableVars);

        return new TsqlHoverContext(
            hoverTokenRange,
            parts,
            hoveredIdx,
            isObjectPos,
            isCall,
            isTypePos,
            isUseDb,
            activeDatabase,
            stmtScope.Sources,
            stmtScope.OuterSources,
            stmtScope.Ctes,
            tempTables,
            tableVars,
            scalarVars);
    }

    private static TsqlCompletionContext EmptyCompletion(LanguageRange range, string? db) =>
        new(TsqlSiteKind.None, TsqlObjectHint.Any, range, "", false, false, db, [], false, [], [], null, [], null,
            new HashSet<string>(StringComparer.Ordinal), [], new Dictionary<string, LocalTable>(),
            new Dictionary<string, LocalTable>(), new Dictionary<string, LocalVariable>(), false, false);

    private static bool IsTrivia(TSqlParserToken token) =>
        token.TokenType is TSqlTokenType.WhiteSpace or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment;

    private static bool IsContextKeyword(TSqlParserToken token, string keyword) =>
        !string.IsNullOrEmpty(token.Text) && string.Equals(token.Text, keyword, StringComparison.OrdinalIgnoreCase);

    private static bool IsNameToken(TSqlParserToken token) =>
        token.TokenType is TSqlTokenType.Identifier or TSqlTokenType.QuotedIdentifier or TSqlTokenType.AsciiStringOrQuotedIdentifier;

    private static bool IsQuotedOrPlainIdent(TSqlParserToken token) =>
        token.TokenType == TSqlTokenType.Identifier
        || token.TokenType == TSqlTokenType.QuotedIdentifier
        || (token.TokenType == TSqlTokenType.AsciiStringOrQuotedIdentifier && token.Text.StartsWith('"'));

    private static bool IsIdentifierOrHoverable(TSqlParserToken token)
    {
        if (IsQuotedOrPlainIdent(token)) return true;
        if (token.TokenType == TSqlTokenType.Variable) return true;
        // Built-in functions / types that ScriptDom lexes as keyword tokens (LEFT, RIGHT, COALESCE, CONVERT, NULLIF, CURRENT_TIMESTAMP, etc.).
        if (!string.IsNullOrEmpty(token.Text) && (TsqlCatalog.FunctionMap.ContainsKey(token.Text) || TsqlCatalog.DataTypeMap.ContainsKey(token.Text)))
            return true;
        return false;
    }

    private static bool IsInsideCommentOrString(IList<TSqlParserToken> tokens, int cursor)
    {
        foreach (var token in tokens)
        {
            if (token.Offset > cursor) break;
            var len = token.Text?.Length ?? 0;
            var end = token.Offset + len;
            if (cursor < token.Offset || cursor > end) continue;
            if (token.TokenType == TSqlTokenType.SingleLineComment && cursor > token.Offset) return true;
            if (token.TokenType == TSqlTokenType.MultilineComment && cursor > token.Offset && (cursor < end || !token.Text!.EndsWith("*/", StringComparison.Ordinal)))
                return true;
            if (token.TokenType is TSqlTokenType.AsciiStringLiteral or TSqlTokenType.UnicodeStringLiteral)
            {
                // Caret strictly inside '...' or at end of unterminated string literal.
                if (cursor > token.Offset && (cursor < end || !IsTerminatedString(token.Text!))) return true;
            }
            if (token.TokenType == TSqlTokenType.AsciiStringOrQuotedIdentifier && token.Text!.StartsWith('\''))
            {
                if (cursor > token.Offset && (cursor < end || !IsTerminatedString(token.Text!))) return true;
            }
            if (token.TokenType == TSqlTokenType.None && token.Text is { Length: > 0 } err)
            {
                if (err[0] == '\'' || (err.Length >= 2 && (err[0] is 'N' or 'n') && err[1] == '\'')) return true;
                if (err.StartsWith("/*", StringComparison.Ordinal)) return true;
            }
        }
        return false;
    }

    private static bool IsTerminatedString(string text)
    {
        var start = text.StartsWith("N'", StringComparison.OrdinalIgnoreCase) ? 2 : 1;
        return text.Length > start && text[^1] == '\'';
    }

    private static LanguageRange TokenRange(string text, TSqlParserToken token) =>
        new(DefinitionNames.PositionOf(text, token.Offset), DefinitionNames.PositionOf(text, token.Offset + (token.Text?.Length ?? 0)));

    private static int FindHoverToken(IList<TSqlParserToken> tokens, int offset)
    {
        var after = -1;
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (token.Offset > offset) break;
            var end = token.Offset + (token.Text?.Length ?? 0);
            if (offset < end) return IsIdentifierOrHoverable(token) ? i : after;
            if (offset == end && IsIdentifierOrHoverable(token)) after = i;
        }
        return after;
    }

    private static (int From, int To) FindBatchBounds(IList<TSqlParserToken> tokens, int textLength, int cursor)
    {
        var from = 0;
        var to = textLength;
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (token.TokenType != TSqlTokenType.Go) continue;
            if (token.Offset >= cursor) { to = token.Offset; break; }
            var after = token.Offset + token.Text.Length;
            var next = i + 1;
            while (next < tokens.Count && tokens[next].TokenType == TSqlTokenType.WhiteSpace && !tokens[next].Text.Contains('\n')) next++;
            if (next < tokens.Count && tokens[next].TokenType == TSqlTokenType.Integer) after = tokens[next].Offset + tokens[next].Text.Length;
            if (after <= cursor) from = after;
        }
        return (from, to);
    }

    private static (int From, int To) FindStatementBounds(IList<TSqlParserToken> tokens, int batchFrom, int batchTo, int cursor)
    {
        var bounds = new List<int> { batchFrom };
        var depth = 0;
        var prevNonTrivia = TSqlTokenType.None;
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (token.Offset < batchFrom) continue;
            if (token.Offset >= batchTo) break;
            if (IsTrivia(token)) continue;
            if (token.TokenType == TSqlTokenType.LeftParenthesis) depth++;
            else if (token.TokenType == TSqlTokenType.RightParenthesis) depth = Math.Max(0, depth - 1);
            else if (token.TokenType == TSqlTokenType.Semicolon)
            {
                bounds.Add(token.Offset + 1);
                depth = 0;
            }
            else if (depth == 0 && token.Offset > batchFrom && StatementStarters.Contains(token.TokenType))
            {
                // Don't split WITH inside table hints `FROM t WITH (NOLOCK)`, or SELECT after UNION / AS / INSERT, or SET inside UPDATE ... SET, or BEGIN inside BEGIN TRY/TRAN.
                var isSubClause = token.TokenType switch
                {
                    TSqlTokenType.With => prevNonTrivia is TSqlTokenType.Identifier or TSqlTokenType.QuotedIdentifier or TSqlTokenType.AsciiStringOrQuotedIdentifier or TSqlTokenType.RightParenthesis,
                    TSqlTokenType.Set => prevNonTrivia is not (TSqlTokenType.Semicolon or TSqlTokenType.Begin or TSqlTokenType.Else or TSqlTokenType.None or TSqlTokenType.End) && !IsStatementEndBeforeSet(tokens, i, batchFrom),
                    TSqlTokenType.Select => prevNonTrivia is TSqlTokenType.Union or TSqlTokenType.All or TSqlTokenType.Except or TSqlTokenType.Intersect or TSqlTokenType.As or TSqlTokenType.RightParenthesis or TSqlTokenType.Into or TSqlTokenType.Insert,
                    TSqlTokenType.Insert or TSqlTokenType.Update or TSqlTokenType.Delete => prevNonTrivia is TSqlTokenType.Then || (i > 0 && IsContextKeyword(tokens[PrevNonTrivia(tokens, i)], "MATCHED")),
                    _ => false
                };
                if (!isSubClause) bounds.Add(token.Offset);
            }
            prevNonTrivia = token.TokenType;
        }
        bounds.Add(batchTo);
        bounds = [.. bounds.Distinct().Order()];
        if (bounds.Count < 2) return (batchFrom, batchTo);
        var idx = bounds.FindLastIndex(b => b <= cursor);
        if (idx < 0) idx = 0;
        if (idx >= bounds.Count - 1) idx = Math.Max(0, bounds.Count - 2);
        return (bounds[idx], bounds[idx + 1]);
    }

    private static bool IsStatementEndBeforeSet(IList<TSqlParserToken> tokens, int setIndex, int batchFrom)
    {
        // Check if there is an active UPDATE statement before this SET without a semicolon.
        var depth = 0;
        for (var i = setIndex - 1; i >= 0 && tokens[i].Offset >= batchFrom; i--)
        {
            var t = tokens[i].TokenType;
            if (IsTrivia(tokens[i])) continue;
            if (t == TSqlTokenType.RightParenthesis) depth++;
            else if (t == TSqlTokenType.LeftParenthesis) depth = Math.Max(0, depth - 1);
            if (depth > 0) continue;
            if (t == TSqlTokenType.Update) return false;
            if (t is TSqlTokenType.Semicolon or TSqlTokenType.Select or TSqlTokenType.Insert or TSqlTokenType.Delete or TSqlTokenType.Declare or TSqlTokenType.Create or TSqlTokenType.Use)
                return true;
        }
        return true;
    }

    private static (int Start, int End, string Typed, bool Quoted, int BeforeWordIdx, bool ParenAhead)
        ReadWordAtCaret(string text, IList<TSqlParserToken> tokens, int cursor)
    {
        // Find the token containing or immediately ending at cursor.
        var hit = -1;
        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t.Offset > cursor) break;
            var end = t.Offset + (t.Text?.Length ?? 0);
            if (cursor > t.Offset && cursor < end) { hit = i; break; }
            if (cursor == end && !IsTrivia(t) && t.TokenType != TSqlTokenType.EndOfFile) hit = i;
        }

        int start = cursor, endPos = cursor;
        string typed = "";
        bool quoted = false;
        int beforeIdx;

        if (hit >= 0)
        {
            var tok = tokens[hit];
            var tokEnd = tok.Offset + (tok.Text?.Length ?? 0);

            if (tok.TokenType == TSqlTokenType.QuotedIdentifier && tok.Text is { Length: > 0 } qText && qText.StartsWith('['))
            {
                // Auto-closed `[Fir|]` or complete `[Fir]|` -> replace whole bracketed token so `]` is never doubled.
                start = tok.Offset;
                endPos = tokEnd;
                var insideBeforeCursor = cursor <= tok.Offset + 1 ? "" : text[(tok.Offset + 1)..Math.Min(cursor, tokEnd - (qText.EndsWith(']') ? 1 : 0))];
                typed = insideBeforeCursor.Replace("]]", "]", StringComparison.Ordinal);
                quoted = true;
                beforeIdx = PrevNonTrivia(tokens, hit);
            }
            else if (tok.TokenType == TSqlTokenType.AsciiStringOrQuotedIdentifier && tok.Text is { Length: > 0 } dText && dText.StartsWith('"'))
            {
                start = tok.Offset;
                endPos = tokEnd;
                var insideBeforeCursor = cursor <= tok.Offset + 1 ? "" : text[(tok.Offset + 1)..Math.Min(cursor, tokEnd - (dText.EndsWith('"') ? 1 : 0))];
                typed = insideBeforeCursor.Replace("\"\"", "\"", StringComparison.Ordinal);
                quoted = true;
                beforeIdx = PrevNonTrivia(tokens, hit);
            }
            else if (tok.TokenType == TSqlTokenType.None && tok.Text is { Length: > 0 } err && (err[0] == '[' || err[0] == '"'))
            {
                // Unclosed `[Fir|` or `"Fir|`
                start = tok.Offset;
                endPos = cursor;
                var raw = text[(tok.Offset + 1)..cursor];
                typed = err[0] == '[' ? raw.Replace("]]", "]", StringComparison.Ordinal) : raw.Replace("\"\"", "\"", StringComparison.Ordinal);
                quoted = true;
                beforeIdx = PrevNonTrivia(tokens, hit);
            }
            else if (tok.TokenType == TSqlTokenType.Variable || tok.Text == "@" || tok.Text == "@@")
            {
                start = tok.Offset;
                endPos = cursor;
                typed = text[start..cursor];
                beforeIdx = PrevNonTrivia(tokens, hit);
                // Handle split `@` + `@` if ScriptDom tokenized them separately.
                if (typed == "@" && beforeIdx >= 0 && tokens[beforeIdx].Text == "@" && tokens[beforeIdx].Offset + 1 == start)
                {
                    start = tokens[beforeIdx].Offset;
                    typed = "@@";
                    beforeIdx = PrevNonTrivia(tokens, beforeIdx);
                }
            }
            else if (IsWordToken(tok))
            {
                start = tok.Offset;
                endPos = cursor;
                typed = text[start..cursor];
                beforeIdx = PrevNonTrivia(tokens, hit);
                // Check if immediately preceded by an unclosed `[` or `@` or `@@` (in case lexer split them).
                if (beforeIdx >= 0 && tokens[beforeIdx].Offset + (tokens[beforeIdx].Text?.Length ?? 0) == start)
                {
                    var prevText = tokens[beforeIdx].Text;
                    if (prevText is "[" or "\"")
                    {
                        start = tokens[beforeIdx].Offset;
                        quoted = true;
                        beforeIdx = PrevNonTrivia(tokens, beforeIdx);
                    }
                    else if (prevText is "@" or "@@")
                    {
                        start = tokens[beforeIdx].Offset;
                        typed = prevText + typed;
                        beforeIdx = PrevNonTrivia(tokens, beforeIdx);
                    }
                }
            }
            else if (tok.Text == "[")
            {
                start = tok.Offset;
                endPos = cursor;
                // Check if next token is `]` (empty auto-closed `[|]`)
                if (hit + 1 < tokens.Count && tokens[hit + 1].Offset == cursor && tokens[hit + 1].Text == "]")
                    endPos = tokens[hit + 1].Offset + 1;
                quoted = true;
                typed = "";
                beforeIdx = PrevNonTrivia(tokens, hit);
            }
            else
            {
                beforeIdx = hit;
            }
        }
        else
        {
            // Caret is in whitespace or at start of document. Find last non-trivia token strictly before cursor.
            beforeIdx = -1;
            for (var i = 0; i < tokens.Count; i++)
            {
                var t = tokens[i];
                if (t.Offset >= cursor) break;
                if (!IsTrivia(t) && t.TokenType != TSqlTokenType.EndOfFile) beforeIdx = i;
            }
        }

        // Check if next non-trivia token after endPos is `(`.
        var parenAhead = false;
        for (var i = 0; i < tokens.Count; i++)
        {
            if (tokens[i].Offset < endPos) continue;
            if (IsTrivia(tokens[i])) continue;
            parenAhead = tokens[i].TokenType == TSqlTokenType.LeftParenthesis;
            break;
        }

        return (start, endPos, typed, quoted, beforeIdx, parenAhead);
    }

    private static bool IsWordToken(TSqlParserToken token)
    {
        if (string.IsNullOrEmpty(token.Text)) return false;
        if (token.TokenType is TSqlTokenType.Identifier or TSqlTokenType.Variable) return true;
        // Keyword tokens that user might be typing as prefix of an identifier or keyword (e.g. `ord` or `in` or `use` or `year`).
        var first = token.Text[0];
        return char.IsLetter(first) || first is '_' or '#' or '@';
    }

    private static int PrevNonTrivia(IList<TSqlParserToken> tokens, int idx)
    {
        for (var i = idx - 1; i >= 0; i--)
            if (!IsTrivia(tokens[i]) && tokens[i].TokenType != TSqlTokenType.EndOfFile) return i;
        return -1;
    }

    private static int NextNonTrivia(IList<TSqlParserToken> tokens, int idx)
    {
        for (var i = idx + 1; i < tokens.Count; i++)
            if (!IsTrivia(tokens[i]) && tokens[i].TokenType != TSqlTokenType.EndOfFile) return i;
        return -1;
    }

    /// <summary>Scans the script before <paramref name="cursor"/> for mid-script USE, script-wide #temp / ##global_temp
    /// tables (persisting across GO), and current-batch @table / @scalar variables &amp; proc/func parameters.</summary>
    private static void CollectScriptAndBatchLocals(
        IList<TSqlParserToken> tokens,
        string text,
        int cursor,
        int batchFrom,
        ref string? activeDatabase,
        Dictionary<string, LocalTable> tempTables,
        Dictionary<string, LocalTable> tableVars,
        Dictionary<string, LocalVariable> scalarVars)
    {
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (token.Offset >= cursor) break;
            if (IsTrivia(token)) continue;
            var inCurrentBatch = token.Offset >= batchFrom;

            // Mid-script USE <db>
            if (token.TokenType == TSqlTokenType.Use)
            {
                var next = NextNonTrivia(tokens, i);
                if (next >= 0 && tokens[next].Offset < cursor && IsQuotedOrPlainIdent(tokens[next]))
                {
                    var afterDb = NextNonTrivia(tokens, next);
                    if (afterDb < 0 || tokens[afterDb].TokenType != TSqlTokenType.LeftParenthesis)
                    {
                        var dbName = TsqlCatalog.Unquote(tokens[next].Text);
                        if (dbName.Length is > 0 and <= 128) activeDatabase = dbName;
                    }
                }
                continue;
            }

            // CREATE TABLE #temp (...) / ##global_temp (...) — persists across GO batches!
            if (token.TokenType == TSqlTokenType.Create)
            {
                var next = NextNonTrivia(tokens, i);
                if (next >= 0 && tokens[next].TokenType == TSqlTokenType.Table)
                {
                    var nameIdx = NextNonTrivia(tokens, next);
                    if (nameIdx >= 0 && tokens[nameIdx].Offset < cursor && IsQuotedOrPlainIdent(tokens[nameIdx]))
                    {
                        var tableName = TsqlCatalog.Unquote(tokens[nameIdx].Text);
                        if (tableName.StartsWith('#') && tempTables.Count < MaxLocalTables)
                        {
                            var openParen = NextNonTrivia(tokens, nameIdx);
                            if (openParen >= 0 && tokens[openParen].TokenType == TSqlTokenType.LeftParenthesis)
                            {
                                var cols = ParseColumnDefinitionList(tokens, openParen, cursor, out var endIdx);
                                tempTables[tableName] = new LocalTable(tableName, false, cols);
                                i = endIdx;
                            }
                        }
                    }
                }
                else if (inCurrentBatch && next >= 0 && (tokens[next].TokenType is TSqlTokenType.Procedure or TSqlTokenType.Proc or TSqlTokenType.Function))
                {
                    ScanRoutineParameters(tokens, next, cursor, tableVars, scalarVars);
                }
                continue;
            }

            // ALTER PROC / FUNCTION parameters in current batch
            if (inCurrentBatch && token.TokenType == TSqlTokenType.Alter)
            {
                var next = NextNonTrivia(tokens, i);
                if (next >= 0 && (tokens[next].TokenType is TSqlTokenType.Procedure or TSqlTokenType.Proc or TSqlTokenType.Function))
                    ScanRoutineParameters(tokens, next, cursor, tableVars, scalarVars);
                continue;
            }

            // DROP TABLE [IF EXISTS] #temp
            if (token.TokenType == TSqlTokenType.Drop)
            {
                var next = NextNonTrivia(tokens, i);
                if (next >= 0 && tokens[next].TokenType == TSqlTokenType.Table)
                {
                    var cur = NextNonTrivia(tokens, next);
                    if (cur >= 0 && tokens[cur].TokenType == TSqlTokenType.If)
                    {
                        cur = NextNonTrivia(tokens, cur);
                        if (cur >= 0 && tokens[cur].TokenType == TSqlTokenType.Exists) cur = NextNonTrivia(tokens, cur);
                    }
                    if (cur >= 0 && tokens[cur].Offset < cursor && IsQuotedOrPlainIdent(tokens[cur]))
                    {
                        var dropped = TsqlCatalog.Unquote(tokens[cur].Text);
                        if (dropped.StartsWith('#')) tempTables.Remove(dropped);
                    }
                }
                continue;
            }

            // SELECT ... INTO #temp FROM ... — persists across GO batches!
            if (token.TokenType == TSqlTokenType.Into && tempTables.Count < MaxLocalTables)
            {
                var prev = PrevNonTrivia(tokens, i);
                // Ignore INSERT INTO and OUTPUT ... INTO (only capture SELECT ... INTO #temp)
                if (prev >= 0 && tokens[prev].TokenType is not (TSqlTokenType.Insert or TSqlTokenType.Merge))
                {
                    var nameIdx = NextNonTrivia(tokens, i);
                    if (nameIdx >= 0 && tokens[nameIdx].Offset < cursor && IsQuotedOrPlainIdent(tokens[nameIdx]))
                    {
                        var tableName = TsqlCatalog.Unquote(tokens[nameIdx].Text);
                        if (tableName.StartsWith('#'))
                        {
                            var parsed = ParseSelectIntoTemp(text, tokens, i, cursor, tableName);
                            if (parsed is not null) tempTables[tableName] = parsed;
                        }
                    }
                }
                continue;
            }

            // DECLARE @var TYPE / DECLARE @tbl TABLE (...) — scoped ONLY to current GO batch!
            if (inCurrentBatch && token.TokenType == TSqlTokenType.Declare)
            {
                i = ScanDeclareStatement(tokens, i, cursor, tableVars, scalarVars);
            }
        }
    }

    private static LocalTable? ParseSelectIntoTemp(string text, IList<TSqlParserToken> tokens, int intoIdx, int cursor, string tableName)
    {
        // Find enclosing SELECT before intoIdx.
        var selectIdx = -1;
        var depth = 0;
        for (var j = intoIdx - 1; j >= 0; j--)
        {
            var t = tokens[j].TokenType;
            if (IsTrivia(tokens[j])) continue;
            if (t == TSqlTokenType.RightParenthesis) depth++;
            else if (t == TSqlTokenType.LeftParenthesis) depth = Math.Max(0, depth - 1);
            else if (depth == 0)
            {
                if (t == TSqlTokenType.Select) { selectIdx = j; break; }
                if (t is TSqlTokenType.Semicolon or TSqlTokenType.Go or TSqlTokenType.Insert || IsContextKeyword(tokens[j], "OUTPUT")) return null;
            }
        }
        if (selectIdx < 0) return null;

        // Find end of this SELECT INTO statement (semicolon, GO, next statement starter at depth 0, or cursor).
        var endOffset = cursor;
        depth = 0;
        for (var j = intoIdx + 1; j < tokens.Count && tokens[j].Offset < cursor; j++)
        {
            var t = tokens[j].TokenType;
            if (IsTrivia(tokens[j])) continue;
            if (t == TSqlTokenType.LeftParenthesis) depth++;
            else if (t == TSqlTokenType.RightParenthesis) depth = Math.Max(0, depth - 1);
            else if (depth == 0 && (t is TSqlTokenType.Semicolon or TSqlTokenType.Go || StatementStarters.Contains(t)))
            {
                endOffset = tokens[j].Offset;
                break;
            }
        }

        var snippet = text[tokens[selectIdx].Offset..endOffset];
        var parser = new TSql180Parser(initialQuotedIdentifiers: true);
        var stmtTokens = parser.GetTokenStream(new StringReader(snippet), out var errors);
        if (errors.Count == 0 && SqlToolsLanguageService.BoundedCompletionSyntax(stmtTokens))
        {
            var fragment = parser.Parse(stmtTokens, out errors);
            if (errors.Count == 0 && fragment is TSqlScript { Batches: [{ Statements: [SelectStatement { QueryExpression: QuerySpecification spec }, ..] }, ..] })
            {
                var (cols, hasStar, starSources) = ExtractQueryProjection(spec, snippet, new Dictionary<string, TsqlCteInfo>(StringComparer.OrdinalIgnoreCase),
                    new Dictionary<string, LocalTable>(StringComparer.OrdinalIgnoreCase), new Dictionary<string, LocalTable>(StringComparer.OrdinalIgnoreCase));
                return new LocalTable(tableName, false, cols, starSources, hasStar);
            }
        }

        // Token fallback: scan projected column names between SELECT and INTO.
        var fallbackCols = new List<LocalColumn>();
        var sawStar = false;
        depth = 0;
        for (var j = selectIdx + 1; j < intoIdx; j++)
        {
            var tok = tokens[j];
            if (IsTrivia(tok)) continue;
            if (tok.TokenType == TSqlTokenType.LeftParenthesis) { depth++; continue; }
            if (tok.TokenType == TSqlTokenType.RightParenthesis) { depth = Math.Max(0, depth - 1); continue; }
            if (depth > 0) continue;
            if (tok.TokenType == TSqlTokenType.Star) sawStar = true;
            else if (tok.TokenType == TSqlTokenType.Comma)
            {
                var prev = PrevNonTrivia(tokens, j);
                if (prev > selectIdx && IsQuotedOrPlainIdent(tokens[prev]))
                    fallbackCols.Add(new LocalColumn(TsqlCatalog.Unquote(tokens[prev].Text)));
            }
        }
        var lastBeforeInto = PrevNonTrivia(tokens, intoIdx);
        if (lastBeforeInto > selectIdx && IsQuotedOrPlainIdent(tokens[lastBeforeInto]))
            fallbackCols.Add(new LocalColumn(TsqlCatalog.Unquote(tokens[lastBeforeInto].Text)));
        return new LocalTable(tableName, false, fallbackCols, null, sawStar);
    }

    private static int ScanDeclareStatement(
        IList<TSqlParserToken> tokens,
        int declareIdx,
        int cursor,
        Dictionary<string, LocalTable> tableVars,
        Dictionary<string, LocalVariable> scalarVars)
    {
        var i = NextNonTrivia(tokens, declareIdx);
        while (i >= 0 && tokens[i].Offset < cursor)
        {
            if (tokens[i].TokenType != TSqlTokenType.Variable) break;
            var varName = tokens[i].Text;
            var cur = NextNonTrivia(tokens, i);
            if (cur < 0 || tokens[cur].Offset >= cursor) break;
            if (tokens[cur].TokenType == TSqlTokenType.As) cur = NextNonTrivia(tokens, cur);
            if (cur < 0 || tokens[cur].Offset >= cursor) break;

            if (tokens[cur].TokenType == TSqlTokenType.Table)
            {
                var openParen = NextNonTrivia(tokens, cur);
                if (openParen >= 0 && tokens[openParen].TokenType == TSqlTokenType.LeftParenthesis && tableVars.Count < MaxLocalTables)
                {
                    var cols = ParseColumnDefinitionList(tokens, openParen, cursor, out var endIdx);
                    tableVars[varName] = new LocalTable(varName, true, cols);
                    i = endIdx;
                }
                break;
            }

            // Scalar variable (or user-defined table type variable): read type name + optional (precision/scale).
            var (typeText, afterTypeIdx, udtRef) = ReadTypeExpression(tokens, cur, cursor);
            if (scalarVars.Count < MaxLocalVariables)
                scalarVars[varName] = new LocalVariable(varName, typeText);
            if (udtRef is not null && tableVars.Count < MaxLocalTables)
                tableVars[varName] = new LocalTable(varName, true, [], TableTypeRef: udtRef);

            // Skip optional `= <default expr>` until comma at depth 0 or statement boundary.
            var scan = afterTypeIdx;
            var depth = 0;
            while (scan >= 0 && scan < tokens.Count && tokens[scan].Offset < cursor)
            {
                var t = tokens[scan].TokenType;
                if (IsTrivia(tokens[scan])) { scan++; continue; }
                if (t == TSqlTokenType.LeftParenthesis) depth++;
                else if (t == TSqlTokenType.RightParenthesis) depth = Math.Max(0, depth - 1);
                else if (depth == 0)
                {
                    if (t == TSqlTokenType.Comma) { i = NextNonTrivia(tokens, scan); goto NextVar; }
                    if (t is TSqlTokenType.Semicolon or TSqlTokenType.Go || StatementStarters.Contains(t))
                        return scan - 1;
                }
                scan++;
            }
            return Math.Max(declareIdx, scan - 1);
        NextVar:;
        }
        return declareIdx;
    }

    private static void ScanRoutineParameters(
        IList<TSqlParserToken> tokens,
        int kindIdx,
        int cursor,
        Dictionary<string, LocalTable> tableVars,
        Dictionary<string, LocalVariable> scalarVars)
    {
        var cur = NextNonTrivia(tokens, kindIdx);
        // Skip routine name (schema.name)
        while (cur >= 0 && tokens[cur].Offset < cursor && (IsQuotedOrPlainIdent(tokens[cur]) || tokens[cur].TokenType == TSqlTokenType.Dot))
            cur = NextNonTrivia(tokens, cur);
        if (cur < 0 || tokens[cur].Offset >= cursor) return;
        var inParens = tokens[cur].TokenType == TSqlTokenType.LeftParenthesis;
        if (inParens) cur = NextNonTrivia(tokens, cur);
        while (cur >= 0 && tokens[cur].Offset < cursor)
        {
            if (tokens[cur].TokenType is TSqlTokenType.As or TSqlTokenType.Begin or TSqlTokenType.RightParenthesis || IsContextKeyword(tokens[cur], "RETURNS")) break;
            if (tokens[cur].TokenType == TSqlTokenType.Variable)
            {
                var paramName = tokens[cur].Text;
                var typeStart = NextNonTrivia(tokens, cur);
                if (typeStart >= 0 && tokens[typeStart].TokenType == TSqlTokenType.As) typeStart = NextNonTrivia(tokens, typeStart);
                if (typeStart >= 0 && tokens[typeStart].Offset < cursor)
                {
                    var (typeText, afterIdx, udtRef) = ReadTypeExpression(tokens, typeStart, cursor);
                    if (scalarVars.Count < MaxLocalVariables) scalarVars[paramName] = new LocalVariable(paramName, typeText);
                    if (udtRef is not null && tableVars.Count < MaxLocalTables)
                        tableVars[paramName] = new LocalTable(paramName, true, [], TableTypeRef: udtRef);
                    cur = afterIdx;
                    continue;
                }
            }
            cur = NextNonTrivia(tokens, cur);
        }
    }

    private static (string? TypeText, int AfterIdx, TsqlObjectRef? UdtRef) ReadTypeExpression(IList<TSqlParserToken> tokens, int startIdx, int limitOffset)
    {
        if (startIdx < 0 || startIdx >= tokens.Count || tokens[startIdx].Offset >= limitOffset) return (null, startIdx, null);
        var first = tokens[startIdx];
        if (string.IsNullOrEmpty(first.Text)) return (null, startIdx + 1, null);
        var sb = new StringBuilder();
        var next = NextNonTrivia(tokens, startIdx);
        TsqlObjectRef? udt = null;

        // Schema-qualified type: dbo.MyTableType
        if (next >= 0 && tokens[next].TokenType == TSqlTokenType.Dot)
        {
            var typeNameIdx = NextNonTrivia(tokens, next);
            if (typeNameIdx >= 0 && tokens[typeNameIdx].Offset < limitOffset && IsQuotedOrPlainIdent(tokens[typeNameIdx]))
            {
                var schema = TsqlCatalog.Unquote(first.Text);
                var name = TsqlCatalog.Unquote(tokens[typeNameIdx].Text);
                sb.Append(schema).Append('.').Append(name);
                udt = new TsqlObjectRef(null, schema, name);
                next = NextNonTrivia(tokens, typeNameIdx);
                return (sb.ToString(), next < 0 ? tokens.Count : next, udt);
            }
        }

        sb.Append(TsqlCatalog.Unquote(first.Text));
        if (next >= 0 && tokens[next].Offset < limitOffset && tokens[next].TokenType == TSqlTokenType.LeftParenthesis)
        {
            sb.Append('(');
            var cur = next + 1;
            var depth = 1;
            while (cur < tokens.Count && tokens[cur].Offset < limitOffset && depth > 0)
            {
                var tok = tokens[cur];
                if (tok.TokenType == TSqlTokenType.LeftParenthesis) depth++;
                else if (tok.TokenType == TSqlTokenType.RightParenthesis) { depth--; if (depth == 0) { sb.Append(')'); cur++; break; } }
                if (!IsTrivia(tok)) sb.Append(tok.Text);
                cur++;
            }
            return (sb.ToString(), cur, udt);
        }
        return (sb.ToString(), next < 0 ? tokens.Count : next, udt);
    }

    private static List<LocalColumn> ParseColumnDefinitionList(IList<TSqlParserToken> tokens, int openParenIdx, int limitOffset, out int endIdx)
    {
        var columns = new List<LocalColumn>();
        var depth = 1;
        var cur = openParenIdx + 1;
        var expectColName = true;
        endIdx = openParenIdx;

        while (cur < tokens.Count && tokens[cur].Offset < limitOffset && depth > 0)
        {
            endIdx = cur;
            var tok = tokens[cur];
            if (IsTrivia(tok)) { cur++; continue; }
            if (tok.TokenType == TSqlTokenType.LeftParenthesis) { depth++; cur++; continue; }
            if (tok.TokenType == TSqlTokenType.RightParenthesis) { depth--; cur++; continue; }
            if (depth > 1) { cur++; continue; }
            if (tok.TokenType == TSqlTokenType.Comma) { expectColName = true; cur++; continue; }

            if (expectColName)
            {
                expectColName = false;
                // Table-level constraints inside CREATE TABLE: PRIMARY KEY, CONSTRAINT, UNIQUE, CHECK, FOREIGN KEY, INDEX
                if (tok.TokenType is TSqlTokenType.Constraint or TSqlTokenType.Primary or TSqlTokenType.Unique
                    or TSqlTokenType.Check or TSqlTokenType.Foreign or TSqlTokenType.Index)
                {
                    cur++;
                    continue;
                }
                if (IsQuotedOrPlainIdent(tok) || IsWordToken(tok))
                {
                    var colName = TsqlCatalog.Unquote(tok.Text);
                    var typeIdx = NextNonTrivia(tokens, cur);
                    string? typeText = null;
                    bool? nullable = null;
                    if (typeIdx >= 0 && tokens[typeIdx].Offset < limitOffset && tokens[typeIdx].TokenType != TSqlTokenType.As)
                    {
                        var (parsedType, afterType, _) = ReadTypeExpression(tokens, typeIdx, limitOffset);
                        typeText = parsedType;
                        // Peek for NOT NULL / NULL before comma or closing paren.
                        var scan = afterType;
                        var innerDepth = 0;
                        while (scan >= 0 && scan < tokens.Count && tokens[scan].Offset < limitOffset)
                        {
                            var st = tokens[scan].TokenType;
                            if (IsTrivia(tokens[scan])) { scan++; continue; }
                            if (st == TSqlTokenType.LeftParenthesis) innerDepth++;
                            else if (st == TSqlTokenType.RightParenthesis) { if (innerDepth == 0) break; innerDepth--; }
                            else if (innerDepth == 0 && st == TSqlTokenType.Comma) break;
                            else if (innerDepth == 0 && st == TSqlTokenType.Not)
                            {
                                var afterNot = NextNonTrivia(tokens, scan);
                                if (afterNot >= 0 && tokens[afterNot].TokenType == TSqlTokenType.Null) { nullable = false; break; }
                            }
                            else if (innerDepth == 0 && st == TSqlTokenType.Null) { nullable = true; break; }
                            scan++;
                        }
                        cur = Math.Max(cur + 1, afterType);
                    }
                    else
                    {
                        cur++;
                    }
                    if (!string.IsNullOrEmpty(colName) && columns.Count < 512)
                        columns.Add(new LocalColumn(colName, typeText, nullable));
                    continue;
                }
            }
            cur++;
        }
        return columns;
    }

    private sealed record StatementScopeResult(
        IReadOnlyList<TsqlSourceRef> Sources,
        IReadOnlyList<TsqlSourceRef> OuterSources,
        TsqlSourceRef? JoinRightSource,
        IReadOnlyList<TsqlSourceRef> JoinLeftSources,
        TsqlSourceRef? InsertTarget,
        TsqlSourceRef? DmlTarget,
        IReadOnlySet<string> OutputAliases,
        IReadOnlyList<TsqlCteInfo> Ctes);

    private static StatementScopeResult ParseStatementScope(
        string text,
        IList<TSqlParserToken> allTokens,
        int stmtFrom,
        int stmtTo,
        int replaceStart,
        int replaceEnd,
        int cursor,
        IReadOnlyDictionary<string, LocalTable> tempTables,
        IReadOnlyDictionary<string, LocalTable> tableVars)
    {
        var stmtText = text[stmtFrom..stmtTo];
        var relStart = Math.Clamp(replaceStart - stmtFrom, 0, stmtText.Length);
        var relEnd = Math.Clamp(replaceEnd - stmtFrom, relStart, stmtText.Length);
        var relCursor = Math.Clamp(cursor - stmtFrom, 0, stmtText.Length);

        var parser = new TSql180Parser(initialQuotedIdentifiers: true);

        // Try direct parse first, then targeted cursor repairs for incomplete mid-typing SQL.
        foreach (var candidate in BuildParseCandidates(stmtText, relStart, relEnd, relCursor))
        {
            var tokens = parser.GetTokenStream(new StringReader(candidate.Text), out var errors);
            if (errors.Count != 0 || !SqlToolsLanguageService.BoundedCompletionSyntax(tokens)) continue;
            var fragment = parser.Parse(tokens, out errors);
            if (errors.Count != 0) continue;
            var extracted = ExtractFromAst(fragment, candidate.Text, candidate.CaretOffset, tempTables, tableVars);
            if (extracted is not null) return extracted;
        }

        // Fast bounded token-stream fallback for heavily broken / mid-edit SQL.
        return ScanTokenScope(text, allTokens, stmtFrom, stmtTo, tempTables, tableVars);
    }

    private static IEnumerable<(string Text, int CaretOffset)> BuildParseCandidates(string stmtText, int relStart, int relEnd, int relCursor)
    {
        // 1. As-is (works for hover and complete statements).
        yield return (stmtText, relCursor);

        // 2. Replace current word/caret with marker identifier (works for `SELECT | FROM t`, `SELECT o.| FROM t o`, `SELECT hi| FROM t`).
        var withMarker = stmtText[..relStart] + "[" + CursorMarker + "]" + stmtText[relEnd..];
        yield return (withMarker, relStart);

        // 3. Trailing ON / WHERE / AND / OR repair: insert `[marker] = 1` + close open parens.
        var openParens = CountUnclosedParens(stmtText);
        var closeSuffix = openParens is > 0 and <= 8 ? new string(')', openParens) : "";
        var withPredicate = stmtText[..relStart] + "[" + CursorMarker + "] = 1" + stmtText[relEnd..] + closeSuffix;
        yield return (withPredicate, relStart);

        // 4. Trailing marker + close open parens (works for `WHERE EXISTS (SELECT | FROM dbo.B b`).
        if (closeSuffix.Length > 0)
            yield return (withMarker + closeSuffix, relStart);

        // 5. Trailing incomplete `JOIN tbl alias ON |` where statement ends after ON or AND.
        var trimmedEnd = stmtText[..relStart].TrimEnd();
        if (trimmedEnd.EndsWith("ON", StringComparison.OrdinalIgnoreCase)
            || trimmedEnd.EndsWith("AND", StringComparison.OrdinalIgnoreCase)
            || trimmedEnd.EndsWith("OR", StringComparison.OrdinalIgnoreCase)
            || trimmedEnd.EndsWith("WHERE", StringComparison.OrdinalIgnoreCase))
        {
            var eqRepair = stmtText[..relStart] + " [" + CursorMarker + "] = 1 " + stmtText[relEnd..] + closeSuffix;
            yield return (eqRepair, relStart + 1);
        }

        // 6. Incomplete `SELECT * FROM dbo.Orders o JOIN dbo.Customers c |` (before ON): append `ON 1=1`.
        yield return (stmtText[..relStart] + " ON [" + CursorMarker + "] = 1 " + stmtText[relEnd..] + closeSuffix, relStart + 4);
    }

    private static int CountUnclosedParens(string sql)
    {
        var depth = 0;
        var inSingle = false;
        var inBracket = false;
        for (var i = 0; i < sql.Length; i++)
        {
            var c = sql[i];
            if (inSingle) { if (c == '\'') inSingle = false; continue; }
            if (inBracket) { if (c == ']') inBracket = false; continue; }
            if (c == '\'') { inSingle = true; continue; }
            if (c == '[') { inBracket = true; continue; }
            if (c == '(') depth++;
            else if (c == ')') depth = Math.Max(0, depth - 1);
        }
        return depth;
    }

    private static StatementScopeResult? ExtractFromAst(
        TSqlFragment fragment,
        string sql,
        int caretOffset,
        IReadOnlyDictionary<string, LocalTable> tempTables,
        IReadOnlyDictionary<string, LocalTable> tableVars)
    {
        var visitor = new ScopeAstVisitor(sql, caretOffset, tempTables, tableVars);
        fragment.Accept(visitor);
        if (visitor.Statement is null && visitor.CurrentSources.Count == 0 && visitor.Ctes.Count == 0)
            return null;
        return new StatementScopeResult(
            visitor.CurrentSources,
            visitor.OuterSources,
            visitor.JoinRightSource,
            visitor.JoinLeftSources,
            visitor.InsertTarget,
            visitor.DmlTarget,
            visitor.OutputAliases,
            visitor.Ctes);
    }

    private static (List<LocalColumn> Columns, bool HasStar, List<TsqlSourceRef> StarSources) ExtractQueryProjection(
        QueryExpression? query,
        string sql,
        IReadOnlyDictionary<string, TsqlCteInfo> ctes,
        IReadOnlyDictionary<string, LocalTable> tempTables,
        IReadOnlyDictionary<string, LocalTable> tableVars,
        IList<Identifier>? explicitColumnNames = null)
    {
        if (explicitColumnNames is { Count: > 0 })
            return ([.. explicitColumnNames.Select(id => new LocalColumn(id.Value))], false, []);

        var spec = FirstQuerySpecification(query);
        if (spec is null) return ([], false, []);

        var fromSources = new List<TsqlSourceRef>();
        if (spec.FromClause is not null)
        {
            foreach (var tr in spec.FromClause.TableReferences)
                CollectTableSources(tr, sql, ctes, tempTables, tableVars, fromSources);
        }

        var cols = new List<LocalColumn>();
        var hasStar = false;
        var starSources = new List<TsqlSourceRef>();

        foreach (var element in spec.SelectElements)
        {
            switch (element)
            {
                case SelectStarExpression star:
                    hasStar = true;
                    if (star.Qualifier?.Identifiers is { Count: > 0 } q)
                    {
                        var qName = q[^1].Value;
                        var matched = fromSources.FirstOrDefault(s => string.Equals(s.ExposureName, qName, StringComparison.OrdinalIgnoreCase));
                        if (matched is not null) starSources.Add(matched);
                    }
                    else
                    {
                        starSources.AddRange(fromSources);
                    }
                    break;
                case SelectScalarExpression scalar:
                    var name = scalar.ColumnName?.Value;
                    if (string.IsNullOrEmpty(name) && scalar.Expression is ColumnReferenceExpression colRef && colRef.MultiPartIdentifier?.Identifiers is { Count: > 0 } ids)
                        name = ids[^1].Value;
                    if (!string.IsNullOrEmpty(name) && name != CursorMarker)
                        cols.Add(new LocalColumn(name));
                    break;
            }
        }
        return (cols, hasStar, starSources);
    }

    private static QuerySpecification? FirstQuerySpecification(QueryExpression? expr) => expr switch
    {
        QuerySpecification spec => spec,
        BinaryQueryExpression bin => FirstQuerySpecification(bin.FirstQueryExpression),
        QueryParenthesisExpression paren => FirstQuerySpecification(paren.QueryExpression),
        _ => null
    };

    private static void CollectTableSources(
        TableReference? tableRef,
        string sql,
        IReadOnlyDictionary<string, TsqlCteInfo> ctes,
        IReadOnlyDictionary<string, LocalTable> tempTables,
        IReadOnlyDictionary<string, LocalTable> tableVars,
        List<TsqlSourceRef> output)
    {
        if (tableRef is null) return;
        switch (tableRef)
        {
            case JoinTableReference join:
                CollectTableSources(join.FirstTableReference, sql, ctes, tempTables, tableVars, output);
                CollectTableSources(join.SecondTableReference, sql, ctes, tempTables, tableVars, output);
                break;
            case JoinParenthesisTableReference paren:
                CollectTableSources(paren.Join, sql, ctes, tempTables, tableVars, output);
                break;
            case NamedTableReference named:
                output.Add(BuildNamedSource(named.SchemaObject, named.Alias, sql, ctes, tempTables, tableVars));
                break;
            case VariableTableReference varTable:
                var varName = varTable.Variable.Name;
                var rawQ = varTable.Alias is { } va ? RawSlice(sql, va) : varName;
                var expName = varTable.Alias?.Value ?? varName;
                tableVars.TryGetValue(varName, out var tv);
                output.Add(new TsqlSourceRef(
                    expName, rawQ, varTable.Alias is not null, "tableVar",
                    ObjectRef: tv?.TableTypeRef,
                    InlineColumns: tv?.Columns));
                break;
            case QueryDerivedTable derived:
                var (dCols, dStar, dStarSources) = ExtractQueryProjection(derived.QueryExpression, sql, ctes, tempTables, tableVars, derived.Columns);
                var dAlias = derived.Alias?.Value ?? "";
                var dRaw = derived.Alias is { } da ? RawSlice(sql, da) : dAlias;
                output.Add(new TsqlSourceRef(dAlias, dRaw, derived.Alias is not null, "derived",
                    InlineColumns: dCols, HasStar: dStar, StarSources: dStarSources));
                break;
            case PivotedTableReference pivoted:
                var pInner = new List<TsqlSourceRef>();
                CollectTableSources(pivoted.TableReference, sql, ctes, tempTables, tableVars, pInner);
                var pCols = pivoted.InColumns.Select(id => new LocalColumn(id.Value)).ToList();
                var pExcluded = new List<string>();
                if (pivoted.PivotColumn?.MultiPartIdentifier?.Identifiers is { Count: > 0 } pColIds) pExcluded.Add(pColIds[^1].Value);
                foreach (var valCol in pivoted.ValueColumns)
                    if (valCol.MultiPartIdentifier?.Identifiers is { Count: > 0 } vIds) pExcluded.Add(vIds[^1].Value);
                var pAlias = pivoted.Alias?.Value ?? "";
                var pRaw = pivoted.Alias is { } pa ? RawSlice(sql, pa) : pAlias;
                output.Add(new TsqlSourceRef(pAlias, pRaw, pivoted.Alias is not null, "pivot",
                    InlineColumns: pCols, HasStar: true, StarSources: pInner, ExcludedColumns: pExcluded));
                break;
            case UnpivotedTableReference unpivoted:
                var uInner = new List<TsqlSourceRef>();
                CollectTableSources(unpivoted.TableReference, sql, ctes, tempTables, tableVars, uInner);
                var uCols = new List<LocalColumn>();
                if (unpivoted.ValueColumn is { Value: { Length: > 0 } uVal }) uCols.Add(new LocalColumn(uVal));
                if (unpivoted.PivotColumn is { Value: { Length: > 0 } uPiv }) uCols.Add(new LocalColumn(uPiv));
                var uExcluded = unpivoted.InColumns.Select(c => c.MultiPartIdentifier?.Identifiers.LastOrDefault()?.Value).OfType<string>().ToList();
                var uAlias = unpivoted.Alias?.Value ?? "";
                var uRaw = unpivoted.Alias is { } ua ? RawSlice(sql, ua) : uAlias;
                output.Add(new TsqlSourceRef(uAlias, uRaw, unpivoted.Alias is not null, "unpivot",
                    InlineColumns: uCols, HasStar: true, StarSources: uInner, ExcludedColumns: uExcluded));
                break;
            case SchemaObjectFunctionTableReference tvf:
                output.Add(BuildNamedSource(tvf.SchemaObject, tvf.Alias, sql, ctes, tempTables, tableVars));
                break;
            case OpenJsonTableReference openJson:
                var ojCols = openJson.SchemaDeclarationItems.Count > 0
                    ? openJson.SchemaDeclarationItems.Select(item => new LocalColumn(item.ColumnDefinition.ColumnIdentifier.Value, item.ColumnDefinition.DataType?.Name?.BaseIdentifier?.Value)).ToList()
                    : [new LocalColumn("key", "nvarchar(4000)"), new LocalColumn("value", "nvarchar(max)"), new LocalColumn("type", "tinyint")];
                var ojAlias = openJson.Alias?.Value ?? "OPENJSON";
                var ojRaw = openJson.Alias is { } oja ? RawSlice(sql, oja) : ojAlias;
                output.Add(new TsqlSourceRef(ojAlias, ojRaw, openJson.Alias is not null, "openjson", InlineColumns: ojCols));
                break;
            case TableReferenceWithAliasAndColumns other:
                var cols = other.Columns.Select(id => new LocalColumn(id.Value)).ToList();
                var oAlias = other.Alias?.Value ?? "";
                var oRaw = other.Alias is { } oa ? RawSlice(sql, oa) : oAlias;
                output.Add(new TsqlSourceRef(oAlias, oRaw, other.Alias is not null, "derived", InlineColumns: cols));
                break;
        }
    }

    private static TsqlSourceRef BuildNamedSource(
        SchemaObjectName objName,
        Identifier? alias,
        string sql,
        IReadOnlyDictionary<string, TsqlCteInfo> ctes,
        IReadOnlyDictionary<string, LocalTable> tempTables,
        IReadOnlyDictionary<string, LocalTable> tableVars)
    {
        var baseName = objName.BaseIdentifier?.Value ?? "";
        var schema = objName.SchemaIdentifier?.Value;
        var db = objName.DatabaseIdentifier?.Value;
        var hasAlias = alias is not null;
        var exposure = alias?.Value ?? baseName;
        var rawQ = alias is not null ? RawSlice(sql, alias) : (objName.BaseIdentifier is not null ? RawSlice(sql, objName.BaseIdentifier) : baseName);

        if (db is null && schema is null)
        {
            if (baseName.StartsWith('#') && tempTables.TryGetValue(baseName, out var temp))
                return new TsqlSourceRef(exposure, rawQ, hasAlias, "temp", InlineColumns: temp.Columns, HasStar: temp.SelectIntoStar, StarSources: temp.SelectIntoSources);
            if (ctes.TryGetValue(baseName, out var cte))
                return new TsqlSourceRef(exposure, rawQ, hasAlias, "cte", InlineColumns: cte.Columns, HasStar: cte.HasStar, StarSources: cte.StarSources);
            if (baseName.StartsWith('#'))
                return new TsqlSourceRef(exposure, rawQ, hasAlias, "temp", InlineColumns: []);
        }

        return new TsqlSourceRef(exposure, rawQ, hasAlias, "table", ObjectRef: new TsqlObjectRef(db, schema, baseName));
    }

    private static string RawSlice(string sql, TSqlFragment fragment)
    {
        if (fragment.StartOffset >= 0 && fragment.FragmentLength > 0 && fragment.StartOffset + fragment.FragmentLength <= sql.Length)
            return sql.Substring(fragment.StartOffset, fragment.FragmentLength);
        return fragment is Identifier id ? id.Value : "";
    }

    private sealed class ScopeAstVisitor(
        string sql,
        int caretOffset,
        IReadOnlyDictionary<string, LocalTable> tempTables,
        IReadOnlyDictionary<string, LocalTable> tableVars) : TSqlFragmentVisitor
    {
        private sealed record ScopeFrame(QuerySpecification? Query, IReadOnlyList<TsqlSourceRef> Sources, bool IsDerivedBoundary, bool IsApply);

        private readonly Dictionary<string, TsqlCteInfo> visibleCtes = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<TsqlCteInfo> cteOrder = [];
        private readonly List<ScopeFrame> stack = [];
        private readonly Dictionary<QueryDerivedTable, IReadOnlyList<TsqlSourceRef>> lateralMap = [];
        private bool foundCaret;

        public TSqlStatement? Statement { get; private set; }
        public List<TsqlSourceRef> CurrentSources { get; private set; } = [];
        public List<TsqlSourceRef> OuterSources { get; private set; } = [];
        public TsqlSourceRef? JoinRightSource { get; private set; }
        public List<TsqlSourceRef> JoinLeftSources { get; private set; } = [];
        public TsqlSourceRef? InsertTarget { get; private set; }
        public TsqlSourceRef? DmlTarget { get; private set; }
        public HashSet<string> OutputAliases { get; private set; } = new(StringComparer.Ordinal);
        public IReadOnlyList<TsqlCteInfo> Ctes => cteOrder;

        private bool Contains(TSqlFragment? node) =>
            node is not null && node.StartOffset >= 0 && node.StartOffset <= caretOffset && caretOffset <= node.StartOffset + node.FragmentLength;

        public override void Visit(TSqlStatement node)
        {
            if (Contains(node)) Statement = node;
        }

        public override void ExplicitVisit(WithCtesAndXmlNamespaces node)
        {
            foreach (var cte in node.CommonTableExpressions)
            {
                // Inside a CTE's body, only prior CTEs are visible for sources.
                if (Contains(cte))
                {
                    cte.Accept(this);
                }
                var (cols, hasStar, starSources) = ExtractQueryProjection(cte.QueryExpression, sql, visibleCtes, tempTables, tableVars, cte.Columns);
                var info = new TsqlCteInfo(cte.ExpressionName.Value, cols, hasStar, starSources);
                visibleCtes[info.Name] = info;
                cteOrder.Add(info);
            }
        }

        public override void ExplicitVisit(SelectStatement node)
        {
            node.WithCtesAndXmlNamespaces?.Accept(this);
            node.QueryExpression?.Accept(this);
        }

        public override void ExplicitVisit(InsertStatement node)
        {
            node.WithCtesAndXmlNamespaces?.Accept(this);
            if (node.InsertSpecification is { } spec)
            {
                var target = ResolveDmlTarget(spec.Target, null);
                if (Contains(spec)) { DmlTarget = target; InsertTarget = target; }
                spec.InsertSource?.Accept(this);
                spec.OutputClause?.Accept(this);
            }
        }

        public override void ExplicitVisit(UpdateStatement node)
        {
            node.WithCtesAndXmlNamespaces?.Accept(this);
            if (node.UpdateSpecification is { } spec && Contains(spec))
            {
                var sources = new List<TsqlSourceRef>();
                if (spec.FromClause is not null)
                    foreach (var tr in spec.FromClause.TableReferences)
                        CollectTableSources(tr, sql, visibleCtes, tempTables, tableVars, sources);
                var target = ResolveDmlTarget(spec.Target, sources);
                DmlTarget = target;
                if (target is not null && !sources.Any(s => string.Equals(s.ExposureName, target.ExposureName, StringComparison.OrdinalIgnoreCase)))
                    sources.Insert(0, target);
                stack.Add(new ScopeFrame(null, sources, false, false));
                CaptureScopes();
                base.ExplicitVisit(spec);
                stack.RemoveAt(stack.Count - 1);
            }
        }

        public override void ExplicitVisit(DeleteStatement node)
        {
            node.WithCtesAndXmlNamespaces?.Accept(this);
            if (node.DeleteSpecification is { } spec && Contains(spec))
            {
                var sources = new List<TsqlSourceRef>();
                if (spec.FromClause is not null)
                    foreach (var tr in spec.FromClause.TableReferences)
                        CollectTableSources(tr, sql, visibleCtes, tempTables, tableVars, sources);
                var target = ResolveDmlTarget(spec.Target, sources);
                DmlTarget = target;
                if (target is not null && !sources.Any(s => string.Equals(s.ExposureName, target.ExposureName, StringComparison.OrdinalIgnoreCase)))
                    sources.Insert(0, target);
                stack.Add(new ScopeFrame(null, sources, false, false));
                CaptureScopes();
                base.ExplicitVisit(spec);
                stack.RemoveAt(stack.Count - 1);
            }
        }

        public override void ExplicitVisit(MergeStatement node)
        {
            node.WithCtesAndXmlNamespaces?.Accept(this);
            if (node.MergeSpecification is { } spec && Contains(spec))
            {
                var sources = new List<TsqlSourceRef>();
                if (spec.Target is NamedTableReference targetNamed)
                {
                    var t = BuildNamedSource(targetNamed.SchemaObject, spec.TableAlias ?? targetNamed.Alias, sql, visibleCtes, tempTables, tableVars);
                    DmlTarget = t;
                    sources.Add(t);
                }
                CollectTableSources(spec.TableReference, sql, visibleCtes, tempTables, tableVars, sources);
                stack.Add(new ScopeFrame(null, sources, false, false));
                CaptureScopes();
                base.ExplicitVisit(spec);
                stack.RemoveAt(stack.Count - 1);
            }
        }

        private TsqlSourceRef? ResolveDmlTarget(TableReference? target, IReadOnlyList<TsqlSourceRef>? fromSources)
        {
            if (target is NamedTableReference named)
            {
                // UPDATE o SET ... FROM dbo.Orders o -> `o` resolves to the FROM alias.
                if (named.SchemaObject is { SchemaIdentifier: null, DatabaseIdentifier: null } && fromSources is not null)
                {
                    var match = fromSources.FirstOrDefault(s => string.Equals(s.ExposureName, named.SchemaObject.BaseIdentifier.Value, StringComparison.OrdinalIgnoreCase));
                    if (match is not null) return match;
                }
                return BuildNamedSource(named.SchemaObject, named.Alias, sql, visibleCtes, tempTables, tableVars);
            }
            if (target is VariableTableReference vt)
            {
                tableVars.TryGetValue(vt.Variable.Name, out var tv);
                return new TsqlSourceRef(vt.Alias?.Value ?? vt.Variable.Name, vt.Variable.Name, vt.Alias is not null, "tableVar",
                    ObjectRef: tv?.TableTypeRef, InlineColumns: tv?.Columns);
            }
            return null;
        }

        public override void ExplicitVisit(QuerySpecification node)
        {
            var sources = new List<TsqlSourceRef>();
            if (node.FromClause is not null)
                foreach (var tr in node.FromClause.TableReferences)
                    CollectTableSources(tr, sql, visibleCtes, tempTables, tableVars, sources);

            stack.Add(new ScopeFrame(node, sources, false, false));
            if (Contains(node))
            {
                CaptureScopes();
                if (node.OrderByClause is not null && Contains(node.OrderByClause))
                {
                    OutputAliases = node.SelectElements
                        .OfType<SelectScalarExpression>()
                        .Select(e => e.ColumnName?.Value)
                        .OfType<string>()
                        .Where(name => name != CursorMarker)
                        .GroupBy(name => name, StringComparer.OrdinalIgnoreCase)
                        .Where(g => g.Count() == 1)
                        .Select(g => g.First())
                        .ToHashSet(StringComparer.Ordinal);
                }
            }
            base.ExplicitVisit(node);
            stack.RemoveAt(stack.Count - 1);
        }

        public override void ExplicitVisit(QualifiedJoin node)
        {
            if (Contains(node.SearchCondition))
            {
                var left = new List<TsqlSourceRef>();
                CollectTableSources(node.FirstTableReference, sql, visibleCtes, tempTables, tableVars, left);
                var right = new List<TsqlSourceRef>();
                CollectTableSources(node.SecondTableReference, sql, visibleCtes, tempTables, tableVars, right);
                if (right.Count == 1 && left.Count > 0)
                {
                    JoinRightSource = right[0];
                    JoinLeftSources = left;
                }
            }
            base.ExplicitVisit(node);
        }

        public override void ExplicitVisit(UnqualifiedJoin node)
        {
            if (node.UnqualifiedJoinType is UnqualifiedJoinType.CrossApply or UnqualifiedJoinType.OuterApply
                && node.SecondTableReference is QueryDerivedTable lateral)
            {
                var leftSources = new List<TsqlSourceRef>();
                CollectTableSources(node.FirstTableReference, sql, visibleCtes, tempTables, tableVars, leftSources);
                lateralMap[lateral] = leftSources;
                try { base.ExplicitVisit(node); }
                finally { lateralMap.Remove(lateral); }
                return;
            }
            base.ExplicitVisit(node);
        }

        public override void ExplicitVisit(QueryDerivedTable node)
        {
            var isApply = lateralMap.TryGetValue(node, out var lateralSources);
            // Derived table skips its immediate enclosing query's sibling sources while retaining higher outer correlations;
            // CROSS/OUTER APPLY additionally sees its left lateral sources!
            stack.Add(new ScopeFrame(null, isApply ? lateralSources! : [], IsDerivedBoundary: true, IsApply: isApply));
            base.ExplicitVisit(node);
            stack.RemoveAt(stack.Count - 1);
        }

        public override void ExplicitVisit(ColumnReferenceExpression node)
        {
            if (!foundCaret && node.MultiPartIdentifier?.Identifiers is { Count: >= 1 } ids
                && ids.Any(id => id.Value == CursorMarker))
            {
                foundCaret = true;
                CaptureScopes();
            }
            base.ExplicitVisit(node);
        }

        private void CaptureScopes()
        {
            var inner = new List<TsqlSourceRef>();
            var outer = new List<TsqlSourceRef>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var skipImmediateEnclosing = false;
            var isFirstQuery = true;

            for (var i = stack.Count - 1; i >= 0; i--)
            {
                var frame = stack[i];
                if (frame.IsDerivedBoundary)
                {
                    if (frame.IsApply)
                    {
                        AddDistinctSources(frame.Sources, isFirstQuery ? inner : outer, seen, markOuter: !isFirstQuery);
                        isFirstQuery = false;
                    }
                    skipImmediateEnclosing = true;
                    continue;
                }
                if (skipImmediateEnclosing)
                {
                    skipImmediateEnclosing = false;
                    continue;
                }
                AddDistinctSources(frame.Sources, isFirstQuery ? inner : outer, seen, markOuter: !isFirstQuery);
                isFirstQuery = false;
            }

            CurrentSources = inner;
            OuterSources = outer;
        }

        private static void AddDistinctSources(IReadOnlyList<TsqlSourceRef> sources, List<TsqlSourceRef> target, HashSet<string> seen, bool markOuter)
        {
            // Exclude duplicate ambiguous correlation names at the same query level (matching SqlCompletionChecks).
            foreach (var group in sources.GroupBy(s => s.ExposureName, StringComparer.Ordinal))
            {
                if (string.IsNullOrEmpty(group.Key)) continue;
                if (!seen.Add(group.Key)) continue;
                if (group.Count() != 1) continue;
                var src = group.Single();
                target.Add(markOuter ? src with { IsOuter = true } : src);
            }
        }
    }

    /// <summary>Fast bounded token-stream fallback when AST parsing cannot parse a heavily broken statement.</summary>
    private static StatementScopeResult ScanTokenScope(
        string text,
        IList<TSqlParserToken> tokens,
        int stmtFrom,
        int stmtTo,
        IReadOnlyDictionary<string, LocalTable> tempTables,
        IReadOnlyDictionary<string, LocalTable> tableVars)
    {
        var sources = new List<TsqlSourceRef>();
        var ctes = new Dictionary<string, TsqlCteInfo>(StringComparer.OrdinalIgnoreCase);
        var cteList = new List<TsqlCteInfo>();
        TsqlSourceRef? dmlTarget = null;
        TsqlSourceRef? insertTarget = null;

        int i = 0;
        while (i < tokens.Count && tokens[i].Offset < stmtFrom) i++;

        // Scan leading WITH cte1 AS (...), cte2 AS (...)
        var firstIdx = i;
        while (firstIdx < tokens.Count && tokens[firstIdx].Offset < stmtTo && IsTrivia(tokens[firstIdx])) firstIdx++;
        if (firstIdx < tokens.Count && tokens[firstIdx].Offset < stmtTo && tokens[firstIdx].TokenType == TSqlTokenType.With)
        {
            var cur = NextNonTrivia(tokens, firstIdx);
            while (cur >= 0 && tokens[cur].Offset < stmtTo && IsQuotedOrPlainIdent(tokens[cur]))
            {
                var cteName = TsqlCatalog.Unquote(tokens[cur].Text);
                var afterName = NextNonTrivia(tokens, cur);
                var cteCols = new List<LocalColumn>();
                if (afterName >= 0 && tokens[afterName].TokenType == TSqlTokenType.LeftParenthesis)
                {
                    // Explicit CTE column list: WITH c (a, b) AS (...)
                    var p = afterName + 1;
                    while (p < tokens.Count && tokens[p].Offset < stmtTo && tokens[p].TokenType != TSqlTokenType.RightParenthesis)
                    {
                        if (IsQuotedOrPlainIdent(tokens[p])) cteCols.Add(new LocalColumn(TsqlCatalog.Unquote(tokens[p].Text)));
                        p++;
                    }
                    afterName = NextNonTrivia(tokens, p);
                }
                if (afterName >= 0 && tokens[afterName].TokenType == TSqlTokenType.As)
                {
                    var openBody = NextNonTrivia(tokens, afterName);
                    if (openBody >= 0 && tokens[openBody].TokenType == TSqlTokenType.LeftParenthesis)
                    {
                        var depth = 1;
                        var p = openBody + 1;
                        while (p < tokens.Count && tokens[p].Offset < stmtTo && depth > 0)
                        {
                            if (tokens[p].TokenType == TSqlTokenType.LeftParenthesis) depth++;
                            else if (tokens[p].TokenType == TSqlTokenType.RightParenthesis) depth--;
                            p++;
                        }
                        var info = new TsqlCteInfo(cteName, cteCols, false, []);
                        ctes[cteName] = info;
                        cteList.Add(info);
                        var afterBody = NextNonTrivia(tokens, p - 1);
                        if (afterBody >= 0 && tokens[afterBody].TokenType == TSqlTokenType.Comma)
                        {
                            cur = NextNonTrivia(tokens, afterBody);
                            continue;
                        }
                        i = Math.Max(i, p);
                        break;
                    }
                }
                break;
            }
        }

        // Scan FROM / JOIN / UPDATE / DELETE / INTO / MERGE table references at paren depth 0.
        var parenDepth = 0;
        for (; i < tokens.Count && tokens[i].Offset < stmtTo; i++)
        {
            var tok = tokens[i];
            if (IsTrivia(tok)) continue;
            if (tok.TokenType == TSqlTokenType.LeftParenthesis) { parenDepth++; continue; }
            if (tok.TokenType == TSqlTokenType.RightParenthesis) { parenDepth = Math.Max(0, parenDepth - 1); continue; }
            if (parenDepth > 0) continue;

            if (tok.TokenType is TSqlTokenType.From or TSqlTokenType.Join or TSqlTokenType.Update or TSqlTokenType.Into or TSqlTokenType.Merge || IsContextKeyword(tok, "USING"))
            {
                var next = NextNonTrivia(tokens, i);
                if (next < 0 || tokens[next].Offset >= stmtTo) continue;
                if (tok.TokenType == TSqlTokenType.Merge && tokens[next].TokenType == TSqlTokenType.Into)
                {
                    next = NextNonTrivia(tokens, next);
                    if (next < 0 || tokens[next].Offset >= stmtTo) continue;
                }
                var src = ReadTokenTableRef(text, tokens, next, stmtTo, ctes, tempTables, tableVars, out var afterRef);
                if (src is not null)
                {
                    if (tok.TokenType == TSqlTokenType.Into) insertTarget ??= src;
                    if (tok.TokenType is TSqlTokenType.Update or TSqlTokenType.Merge or TSqlTokenType.Into) dmlTarget ??= src;
                    if (tok.TokenType != TSqlTokenType.Into) sources.Add(src);
                    i = Math.Max(i, afterRef - 1);
                }
            }
        }

        // Deduplicate by exposure name (excluding duplicates).
        var clean = new List<TsqlSourceRef>();
        foreach (var g in sources.GroupBy(s => s.ExposureName, StringComparer.Ordinal))
            if (!string.IsNullOrEmpty(g.Key) && g.Count() == 1) clean.Add(g.Single());

        return new StatementScopeResult(clean, [], null, [], insertTarget, dmlTarget, new HashSet<string>(StringComparer.Ordinal), cteList);
    }

    private static TsqlSourceRef? ReadTokenTableRef(
        string text,
        IList<TSqlParserToken> tokens,
        int startIdx,
        int limitOffset,
        IReadOnlyDictionary<string, TsqlCteInfo> ctes,
        IReadOnlyDictionary<string, LocalTable> tempTables,
        IReadOnlyDictionary<string, LocalTable> tableVars,
        out int afterIdx)
    {
        afterIdx = startIdx;
        var tok = tokens[startIdx];
        if (tok.TokenType == TSqlTokenType.Variable)
        {
            var varName = tok.Text;
            var (alias, rawAlias, next) = ReadOptionalAlias(tokens, startIdx, limitOffset);
            afterIdx = next;
            tableVars.TryGetValue(varName, out var tv);
            return new TsqlSourceRef(alias ?? varName, rawAlias ?? varName, alias is not null, "tableVar",
                ObjectRef: tv?.TableTypeRef, InlineColumns: tv?.Columns);
        }
        if (!IsQuotedOrPlainIdent(tok)) return null;

        var parts = new List<(string Unquoted, string Raw)> { (TsqlCatalog.Unquote(tok.Text), tok.Text) };
        var cur = startIdx;
        while (parts.Count < 3)
        {
            var dot = NextNonTrivia(tokens, cur);
            if (dot < 0 || tokens[dot].Offset >= limitOffset || tokens[dot].TokenType != TSqlTokenType.Dot) break;
            var seg = NextNonTrivia(tokens, dot);
            if (seg < 0 || tokens[seg].Offset >= limitOffset) break;
            if (tokens[seg].TokenType == TSqlTokenType.Dot)
            {
                parts.Add(("", ""));
                var afterSecondDot = NextNonTrivia(tokens, seg);
                if (afterSecondDot >= 0 && tokens[afterSecondDot].Offset < limitOffset && IsQuotedOrPlainIdent(tokens[afterSecondDot]))
                {
                    parts.Add((TsqlCatalog.Unquote(tokens[afterSecondDot].Text), tokens[afterSecondDot].Text));
                    cur = afterSecondDot;
                }
                break;
            }
            if (!IsQuotedOrPlainIdent(tokens[seg])) break;
            parts.Add((TsqlCatalog.Unquote(tokens[seg].Text), tokens[seg].Text));
            cur = seg;
        }

        string? db = null, schema = null;
        var basePart = parts[^1];
        if (parts.Count == 2) schema = parts[0].Unquoted;
        else if (parts.Count == 3) { db = parts[0].Unquoted; schema = string.IsNullOrEmpty(parts[1].Unquoted) ? null : parts[1].Unquoted; }

        var (optAlias, optRawAlias, nextAfter) = ReadOptionalAlias(tokens, cur, limitOffset);
        afterIdx = nextAfter;

        var exposure = optAlias ?? basePart.Unquoted;
        var rawQ = optRawAlias ?? basePart.Raw;
        if (db is null && schema is null)
        {
            if (basePart.Unquoted.StartsWith('#') && tempTables.TryGetValue(basePart.Unquoted, out var temp))
                return new TsqlSourceRef(exposure, rawQ, optAlias is not null, "temp", InlineColumns: temp.Columns, HasStar: temp.SelectIntoStar, StarSources: temp.SelectIntoSources);
            if (ctes.TryGetValue(basePart.Unquoted, out var cte))
                return new TsqlSourceRef(exposure, rawQ, optAlias is not null, "cte", InlineColumns: cte.Columns, HasStar: cte.HasStar, StarSources: cte.StarSources);
        }
        return new TsqlSourceRef(exposure, rawQ, optAlias is not null, "table", ObjectRef: new TsqlObjectRef(db, schema, basePart.Unquoted));
    }

    private static (string? Alias, string? RawAlias, int AfterIdx) ReadOptionalAlias(IList<TSqlParserToken> tokens, int lastNameIdx, int limitOffset)
    {
        var next = NextNonTrivia(tokens, lastNameIdx);
        if (next < 0 || tokens[next].Offset >= limitOffset) return (null, null, lastNameIdx + 1);
        if (tokens[next].TokenType == TSqlTokenType.As)
        {
            var aliasIdx = NextNonTrivia(tokens, next);
            if (aliasIdx >= 0 && tokens[aliasIdx].Offset < limitOffset && IsQuotedOrPlainIdent(tokens[aliasIdx]))
                return (TsqlCatalog.Unquote(tokens[aliasIdx].Text), tokens[aliasIdx].Text, aliasIdx + 1);
            return (null, null, next + 1);
        }
        if (IsQuotedOrPlainIdent(tokens[next]) && !TsqlCatalog.ReservedKeywords.Contains(tokens[next].Text)
            && !string.Equals(tokens[next].Text, "APPLY", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(tokens[next].Text, "OUTER", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(tokens[next].Text, "INNER", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(tokens[next].Text, "LEFT", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(tokens[next].Text, "RIGHT", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(tokens[next].Text, "FULL", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(tokens[next].Text, "CROSS", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(tokens[next].Text, "JOIN", StringComparison.OrdinalIgnoreCase))
        {
            return (TsqlCatalog.Unquote(tokens[next].Text), tokens[next].Text, next + 1);
        }
        return (null, null, next);
    }

    private static (TsqlSiteKind Site, TsqlObjectHint Hint, List<string> QualifierParts, bool MemberIsObject, TsqlSourceRef? InsertTarget, bool InOrderBy, bool InOutput)
        ClassifySite(
            string text,
            IList<TSqlParserToken> tokens,
            int stmtFrom,
            int stmtTo,
            int replaceStart,
            string typed,
            bool quoted,
            int beforeWordIdx,
            StatementScopeResult stmtScope)
    {
        var qualifiers = new List<string>();
        var inOrderBy = IsInOrderByClause(tokens, beforeWordIdx, stmtFrom);
        var inOutput = IsInOutputClause(tokens, beforeWordIdx, stmtFrom);

        // 1. System global `@@...`
        if (!quoted && typed.StartsWith("@@", StringComparison.Ordinal))
            return (TsqlSiteKind.SystemGlobal, TsqlObjectHint.Any, qualifiers, false, null, inOrderBy, inOutput);

        // 2. Member after `.` (`o.`, `dbo.`, `db.dbo.`, `db..`)
        if (beforeWordIdx >= 0 && tokens[beforeWordIdx].TokenType == TSqlTokenType.Dot)
        {
            var cur = beforeWordIdx;
            var isObj = false;
            while (cur >= 0 && tokens[cur].TokenType == TSqlTokenType.Dot && qualifiers.Count < 3)
            {
                var prev = PrevNonTrivia(tokens, cur);
                if (prev < 0) break;
                if (tokens[prev].TokenType == TSqlTokenType.Dot)
                {
                    // `db..` (empty schema)
                    qualifiers.Insert(0, "");
                    cur = prev;
                    continue;
                }
                if (IsQuotedOrPlainIdent(tokens[prev]) || tokens[prev].TokenType == TSqlTokenType.Variable)
                {
                    qualifiers.Insert(0, TsqlCatalog.Unquote(tokens[prev].Text));
                    cur = PrevNonTrivia(tokens, prev);
                }
                else break;
            }
            if (qualifiers.Count > 0)
            {
                isObj = IsObjectPositionBefore(tokens, cur, stmtFrom);
                var hint = cur >= 0 && tokens[cur].TokenType is TSqlTokenType.Exec or TSqlTokenType.Execute
                    ? TsqlObjectHint.Procedure : TsqlObjectHint.TableOrView;
                return (TsqlSiteKind.Member, hint, qualifiers, isObj, null, inOrderBy, inOutput);
            }
        }

        // 3. Single `@` local variable (unless in object position like `FROM @t`, where @table vars belong)
        if (!quoted && typed.StartsWith('@'))
        {
            if (IsObjectPositionBefore(tokens, beforeWordIdx, stmtFrom))
                return (TsqlSiteKind.Object, TsqlObjectHint.TableOrView, qualifiers, false, null, inOrderBy, inOutput);
            return (TsqlSiteKind.LocalVariable, TsqlObjectHint.Any, qualifiers, false, null, inOrderBy, inOutput);
        }

        // 4. Statement start (empty or right after `;` / `GO` / `BEGIN` / `ELSE`)
        if (beforeWordIdx < 0 || tokens[beforeWordIdx].Offset < stmtFrom
            || tokens[beforeWordIdx].TokenType is TSqlTokenType.Semicolon or TSqlTokenType.Go or TSqlTokenType.Begin or TSqlTokenType.Else)
            return (TsqlSiteKind.StatementStart, TsqlObjectHint.Any, qualifiers, false, null, inOrderBy, inOutput);

        var prevTok = tokens[beforeWordIdx];

        // 5. USE <db>
        if (prevTok.TokenType == TSqlTokenType.Use)
            return (TsqlSiteKind.UseDatabase, TsqlObjectHint.Any, qualifiers, false, null, inOrderBy, inOutput);

        // 6. CAST(x AS |) / TRY_CAST / PARSE / TRY_PARSE / CONVERT(|, x) / TRY_CONVERT(|, x) / DECLARE @x |
        if (IsTypePositionBefore(tokens, beforeWordIdx))
            return (TsqlSiteKind.CastType, TsqlObjectHint.Any, qualifiers, false, null, inOrderBy, inOutput);

        // 7. DATEADD(|, ...) / DATEDIFF / DATEDIFF_BIG / DATENAME / DATEPART / DATETRUNC
        if (prevTok.TokenType == TSqlTokenType.LeftParenthesis)
        {
            var fnIdx = PrevNonTrivia(tokens, beforeWordIdx);
            if (fnIdx >= 0 && TsqlCatalog.DatePartFunctions.Contains(tokens[fnIdx].Text))
                return (TsqlSiteKind.DatePart, TsqlObjectHint.Any, qualifiers, false, null, inOrderBy, inOutput);
        }

        // 8. INSERT INTO tbl (|) column list
        if (IsInsideInsertColumnList(tokens, beforeWordIdx, stmtFrom))
            return (TsqlSiteKind.InsertColumnList, TsqlObjectHint.Any, qualifiers, false, stmtScope.InsertTarget, inOrderBy, inOutput);

        // 9. JOIN ... ON | (or ON ... AND | / OR |)
        if (IsInJoinOnCondition(tokens, beforeWordIdx, stmtFrom))
            return (TsqlSiteKind.JoinCondition, TsqlObjectHint.Any, qualifiers, false, null, inOrderBy, inOutput);

        // 10. Object position (FROM, JOIN, INTO, UPDATE, MERGE, USING, EXEC, comma in FROM, etc.)
        if (IsObjectPositionBefore(tokens, beforeWordIdx, stmtFrom))
        {
            var hint = prevTok.TokenType is TSqlTokenType.Exec or TSqlTokenType.Execute
                ? TsqlObjectHint.Procedure : TsqlObjectHint.TableOrView;
            return (TsqlSiteKind.Object, hint, qualifiers, false, null, inOrderBy, inOutput);
        }

        // 11. Immediately after a FROM/JOIN table (or its alias): clause continuations (WHERE, JOIN, ON, AS, GROUP BY, ORDER BY)
        if (IsAfterFromTable(tokens, beforeWordIdx, stmtFrom))
            return (TsqlSiteKind.AfterFromTable, TsqlObjectHint.Any, qualifiers, false, null, inOrderBy, inOutput);

        // 12. Expression site (SELECT, WHERE, HAVING, GROUP BY, ORDER BY, SET, OUTPUT, etc.)
        return (TsqlSiteKind.Expression, TsqlObjectHint.Any, qualifiers, false, null, inOrderBy, inOutput);
    }

    private static bool IsTypePositionBefore(IList<TSqlParserToken> tokens, int prevIdx)
    {
        if (prevIdx < 0) return false;
        var prev = tokens[prevIdx];
        // CONVERT(|, ...) or TRY_CONVERT(|, ...)
        if (prev.TokenType == TSqlTokenType.LeftParenthesis)
        {
            var fn = PrevNonTrivia(tokens, prevIdx);
            if (fn >= 0 && (string.Equals(tokens[fn].Text, "CONVERT", StringComparison.OrdinalIgnoreCase)
                || string.Equals(tokens[fn].Text, "TRY_CONVERT", StringComparison.OrdinalIgnoreCase)))
                return true;
        }
        // CAST(... AS |), TRY_CAST(... AS |), PARSE(... AS |), TRY_PARSE(... AS |)
        if (prev.TokenType == TSqlTokenType.As)
        {
            var depth = 0;
            for (var i = prevIdx - 1; i >= 0; i--)
            {
                var t = tokens[i].TokenType;
                if (IsTrivia(tokens[i])) continue;
                if (t == TSqlTokenType.RightParenthesis) depth++;
                else if (t == TSqlTokenType.LeftParenthesis)
                {
                    if (depth == 0)
                    {
                        var fn = PrevNonTrivia(tokens, i);
                        return fn >= 0 && (string.Equals(tokens[fn].Text, "CAST", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(tokens[fn].Text, "TRY_CAST", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(tokens[fn].Text, "PARSE", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(tokens[fn].Text, "TRY_PARSE", StringComparison.OrdinalIgnoreCase));
                    }
                    depth--;
                }
            }
        }
        // DECLARE @x |
        if (prev.TokenType == TSqlTokenType.Variable)
        {
            var beforeVar = PrevNonTrivia(tokens, prevIdx);
            if (beforeVar >= 0 && tokens[beforeVar].TokenType == TSqlTokenType.Declare) return true;
        }
        return false;
    }

    private static bool IsObjectPositionBefore(IList<TSqlParserToken> tokens, int prevIdx, int stmtFrom)
    {
        if (prevIdx < 0 || tokens[prevIdx].Offset < stmtFrom) return false;
        var t = tokens[prevIdx].TokenType;
        if (t is TSqlTokenType.From or TSqlTokenType.Join or TSqlTokenType.Into or TSqlTokenType.Update
            or TSqlTokenType.Merge or TSqlTokenType.Exec or TSqlTokenType.Execute
            || IsContextKeyword(tokens[prevIdx], "USING"))
            return true;
        if (t == TSqlTokenType.Table)
        {
            var beforeTable = PrevNonTrivia(tokens, prevIdx);
            if (beforeTable >= 0 && tokens[beforeTable].TokenType is TSqlTokenType.Truncate or TSqlTokenType.Alter or TSqlTokenType.Drop)
                return true;
        }
        if (string.Equals(tokens[prevIdx].Text, "APPLY", StringComparison.OrdinalIgnoreCase))
            return true;
        // Comma directly in a FROM clause: `FROM dbo.Orders o, |`
        if (t == TSqlTokenType.Comma)
        {
            var clause = ActiveClauseKeyword(tokens, prevIdx, stmtFrom);
            return clause is TSqlTokenType.From or TSqlTokenType.Join;
        }
        return false;
    }

    private static bool IsAfterFromTable(IList<TSqlParserToken> tokens, int prevIdx, int stmtFrom)
    {
        if (prevIdx < 0 || tokens[prevIdx].Offset < stmtFrom) return false;
        var prev = tokens[prevIdx];
        // Must follow an identifier, variable, or `)` (derived table) inside a FROM/JOIN clause.
        if (!IsQuotedOrPlainIdent(prev) && prev.TokenType != TSqlTokenType.Variable && prev.TokenType != TSqlTokenType.RightParenthesis)
            return false;
        if (TsqlCatalog.ReservedKeywords.Contains(prev.Text)) return false;
        var clause = ActiveClauseKeyword(tokens, prevIdx, stmtFrom);
        return clause is TSqlTokenType.From or TSqlTokenType.Join;
    }

    private static bool IsInJoinOnCondition(IList<TSqlParserToken> tokens, int prevIdx, int stmtFrom)
    {
        if (prevIdx < 0 || tokens[prevIdx].Offset < stmtFrom) return false;
        var clause = ActiveClauseKeyword(tokens, prevIdx, stmtFrom);
        if (clause != TSqlTokenType.On) return false;
        // Check that the token right before caret is ON, AND, OR, or `(` so we emit FK predicates cleanly.
        var t = tokens[prevIdx].TokenType;
        return t is TSqlTokenType.On or TSqlTokenType.And or TSqlTokenType.Or or TSqlTokenType.LeftParenthesis;
    }

    private static bool IsInOrderByClause(IList<TSqlParserToken> tokens, int prevIdx, int stmtFrom) =>
        ActiveClauseKeyword(tokens, prevIdx, stmtFrom) == TSqlTokenType.Order;

    private static bool IsInOutputClause(IList<TSqlParserToken> tokens, int prevIdx, int stmtFrom)
    {
        var depth = 0;
        for (var i = prevIdx; i >= 0 && tokens[i].Offset >= stmtFrom; i--)
        {
            var tok = tokens[i];
            if (IsTrivia(tok)) continue;
            var t = tok.TokenType;
            if (t == TSqlTokenType.RightParenthesis) { depth++; continue; }
            if (t == TSqlTokenType.LeftParenthesis) { if (depth == 0) return false; depth--; continue; }
            if (depth > 0) continue;
            if (IsContextKeyword(tok, "OUTPUT")) return true;
            if (t is TSqlTokenType.Select or TSqlTokenType.From or TSqlTokenType.Join or TSqlTokenType.On
                or TSqlTokenType.Where or TSqlTokenType.Group or TSqlTokenType.Having or TSqlTokenType.Order
                or TSqlTokenType.Set or TSqlTokenType.Values)
                return false;
        }
        return false;
    }

    private static bool IsInsideInsertColumnList(IList<TSqlParserToken> tokens, int prevIdx, int stmtFrom)
    {
        var depth = 0;
        for (var i = prevIdx; i >= 0 && tokens[i].Offset >= stmtFrom; i--)
        {
            var t = tokens[i].TokenType;
            if (IsTrivia(tokens[i])) continue;
            if (t == TSqlTokenType.RightParenthesis) depth++;
            else if (t == TSqlTokenType.LeftParenthesis)
            {
                if (depth == 0)
                {
                    // Walk back across target table name (db.schema.table) to check for INSERT [INTO].
                    var cur = PrevNonTrivia(tokens, i);
                    var sawName = false;
                    while (cur >= 0 && tokens[cur].Offset >= stmtFrom && (IsQuotedOrPlainIdent(tokens[cur]) || tokens[cur].TokenType is TSqlTokenType.Dot or TSqlTokenType.Variable))
                    {
                        sawName = true;
                        cur = PrevNonTrivia(tokens, cur);
                    }
                    if (!sawName || cur < 0) return false;
                    if (tokens[cur].TokenType == TSqlTokenType.Into) cur = PrevNonTrivia(tokens, cur);
                    return cur >= 0 && tokens[cur].TokenType == TSqlTokenType.Insert;
                }
                depth--;
            }
        }
        return false;
    }

    private static TSqlTokenType ActiveClauseKeyword(IList<TSqlParserToken> tokens, int fromIdx, int stmtFrom)
    {
        var depth = 0;
        for (var i = fromIdx; i >= 0 && tokens[i].Offset >= stmtFrom; i--)
        {
            var tok = tokens[i];
            if (IsTrivia(tok)) continue;
            var t = tok.TokenType;
            if (t == TSqlTokenType.RightParenthesis) { depth++; continue; }
            if (t == TSqlTokenType.LeftParenthesis)
            {
                if (depth == 0) return TSqlTokenType.None;
                depth--;
                continue;
            }
            if (depth > 0) continue;
            if (t is TSqlTokenType.Select or TSqlTokenType.From or TSqlTokenType.Join or TSqlTokenType.On
                or TSqlTokenType.Where or TSqlTokenType.Group or TSqlTokenType.Having or TSqlTokenType.Order
                or TSqlTokenType.Set or TSqlTokenType.Values)
                return t;
        }
        return TSqlTokenType.None;
    }
}
