using Microsoft.SqlServer.TransactSql.ScriptDom;
using Varia.Backend.Search;

namespace Varia.Backend.Language;

/// <summary>In-process T-SQL syntax and catalog-binding diagnostic engine backed by ScriptDom (<see cref="TSql180Parser"/>)
/// and Search Objects' <see cref="IndexLookup"/>. Works offline/disconnected, on Microsoft Entra ID, and while indexing
/// (syntax-only while building, full catalog binding once a database is Ready/Partial), using the shared 32 MB
/// reserved-stack <see cref="TsqlScopeReader.RunOnParseThread{T}"/> worker and bounded-syntax guards so pathological
/// inputs can never overflow the stack or crash the backend.</summary>
internal static class TsqlDiagnosticService
{
    private const int MaxScriptTokens = 1_000_000;
    private const int MaxBatchTokens = 65_536;
    private const int MaxParenDepth = 64;
    private const int MaxStatementParens = 512;
    private const int MaxChainedMethodDots = 48;
    private const int MaxConsecutiveUnary = 32;
    private const int MaxExpressionOperators = 256;
    private const int MaxBlockDepth = 64;
    private const int MaxStatementSelects = 64;
    private const int MaxLocalTables = 256;
    private const int MaxScriptObjects = 1024;
    private const string DiagnosticSource = "sqlserver";

    private static readonly IReadOnlySet<string> TableLikeKinds = new HashSet<string>(StringComparer.Ordinal)
    {
        "table", "view", "function", "synonym", "tableType"
    };

    private static readonly IReadOnlySet<string> StatementBoundaryKeywords = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH", "CREATE", "ALTER", "DROP",
        "DECLARE", "SET", "IF", "ELSE", "WHILE", "BEGIN", "END", "RETURN", "EXEC", "EXECUTE",
        "PRINT", "THROW", "RAISERROR", "USE", "TRUNCATE", "COMMIT", "ROLLBACK", "TRY", "CATCH"
    };

    internal static LanguageDiagnosticResult Analyze(
        LanguageRefreshRequest request,
        IndexLookup? lookup,
        string? defaultDatabase,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var text = request.Text;
        if (string.IsNullOrWhiteSpace(text))
            return new(request.Version, [], false);
        if (text.Length > TsqlLanguageService.MaxTextCharacters)
            return new(request.Version, [], true);

        var lines = new LineIndex(text);
        var collector = new DiagnosticCollector(lines);

        var parser = new TSql180Parser(initialQuotedIdentifiers: true);
        var allTokens = parser.GetTokenStream(new StringReader(text), out _);
        if (allTokens.Count == 0)
            return new(request.Version, [], false);
        if (allTokens.Count > MaxScriptTokens)
            return new(request.Version, [], true);

        var batches = SplitBatches(allTokens, text.Length);
        var state = new ScriptState(defaultDatabase);

        foreach (var batch in batches)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (collector.IsTruncated) break;
            if (batch.End <= batch.Start) continue;
            var slice = text[batch.Start..batch.End];
            if (string.IsNullOrWhiteSpace(slice)) continue;

            var batchTokens = parser.GetTokenStream(new StringReader(slice), out var lexErrors);
            if (lexErrors.Count > 0)
            {
                foreach (var err in lexErrors)
                {
                    var range = MapErrorRange(lines, text, batch.Start, err, batchTokens);
                    collector.Add(range, err.Message, severity: 1, code: $"SQL{err.Number}");
                }
                continue;
            }

            if (!BoundedDiagnosticSyntax(batchTokens))
            {
                collector.MarkIncomplete();
                continue;
            }

            var (fragment, parseErrors) = TsqlScopeReader.RunOnParseThread(() =>
            {
                var parsed = parser.Parse(batchTokens, out var errors);
                return (parsed, errors);
            }, cancellationToken);

            if (parseErrors.Count > 0)
            {
                foreach (var err in parseErrors)
                {
                    var range = MapErrorRange(lines, text, batch.Start, err, batchTokens);
                    collector.Add(range, err.Message, severity: 1, code: $"SQL{err.Number}");
                }
                continue;
            }

            if (fragment is TSqlScript script)
            {
                var binder = new BindingVisitor(lookup, state, batch.Start, collector, cancellationToken);
                script.Accept(binder);
            }
        }

        return collector.Build(request.Version);
    }

    internal static bool BoundedDiagnosticSyntax(IList<TSqlParserToken> tokens)
    {
        if (tokens.Count > MaxBatchTokens) return false;
        var parenDepth = 0;
        var stmtParens = 0;
        var chainedDots = 0;
        var unary = 0;
        var exprOps = 0;
        var blockDepth = 0;
        var stmtSelects = 0;
        var prevType = TSqlTokenType.None;

        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            var type = token.TokenType;
            if (type is TSqlTokenType.WhiteSpace or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment or TSqlTokenType.EndOfFile)
                continue;

            var text = token.Text ?? "";

            if (type == TSqlTokenType.Semicolon && parenDepth == 0)
            {
                stmtParens = 0;
                chainedDots = 0;
                exprOps = 0;
                stmtSelects = 0;
                unary = 0;
                prevType = type;
                continue;
            }

            if (type == TSqlTokenType.Comma && parenDepth == 0)
            {
                exprOps = 0;
                chainedDots = 0;
                unary = 0;
                prevType = type;
                continue;
            }

            if (parenDepth == 0 && StatementBoundaryKeywords.Contains(text))
            {
                exprOps = 0;
                chainedDots = 0;
            }

            if (type == TSqlTokenType.LeftParenthesis)
            {
                if (++parenDepth > MaxParenDepth || ++stmtParens > MaxStatementParens) return false;
            }
            else if (type == TSqlTokenType.RightParenthesis)
            {
                if (parenDepth > 0) parenDepth--;
            }

            if (type == TSqlTokenType.Dot)
            {
                if (prevType == TSqlTokenType.RightParenthesis && ++chainedDots > MaxChainedMethodDots)
                    return false;
            }
            else if (type is not (TSqlTokenType.Identifier or TSqlTokenType.QuotedIdentifier or TSqlTokenType.AsciiStringOrQuotedIdentifier
                or TSqlTokenType.LeftParenthesis or TSqlTokenType.RightParenthesis))
            {
                chainedDots = 0;
            }

            if (type is TSqlTokenType.Begin or TSqlTokenType.Case)
            {
                if (++blockDepth > MaxBlockDepth) return false;
            }
            else if (type == TSqlTokenType.End)
            {
                if (blockDepth > 0) blockDepth--;
            }

            if (type == TSqlTokenType.Select)
            {
                if (++stmtSelects > MaxStatementSelects) return false;
            }

            var isUnary = text is "+" or "-" or "~" || string.Equals(text, "NOT", StringComparison.OrdinalIgnoreCase);
            unary = isUnary ? unary + 1 : 0;
            if (unary > MaxConsecutiveUnary) return false;

            if (type is TSqlTokenType.DoubleColon or TSqlTokenType.Collate
                || text is "+" or "-" or "~" or "*" or "/" or "%" or "^" or "|" or "||" or "&" or "=" or "<" or ">" or "<>" or "<=" or ">=" or "!=" or "!<" or "!>" or "+=" or "-=" or "*=" or "/=" or "%=" or "&=" or "|=" or "^=" or "::"
                || string.Equals(text, "AND", StringComparison.OrdinalIgnoreCase)
                || string.Equals(text, "OR", StringComparison.OrdinalIgnoreCase)
                || string.Equals(text, "COLLATE", StringComparison.OrdinalIgnoreCase)
                || string.Equals(text, "AT", StringComparison.OrdinalIgnoreCase))
            {
                if (++exprOps > MaxExpressionOperators) return false;
            }

            prevType = type;
        }
        return true;
    }

    private readonly record struct BatchSpan(int Start, int End);

    private static List<BatchSpan> SplitBatches(IList<TSqlParserToken> tokens, int textLength)
    {
        var batches = new List<BatchSpan>();
        var batchStart = 0;

        for (var i = 0; i < tokens.Count; i++)
        {
            var tok = tokens[i];
            if (tok.TokenType != TSqlTokenType.Go) continue;

            if (tok.Offset > batchStart)
                batches.Add(new BatchSpan(batchStart, tok.Offset));

            // Advance past `GO`, optional same-line repeat count (`GO 5`), and same-line comments/whitespace.
            var afterGo = tok.Offset + (tok.Text?.Length ?? 0);
            var j = i + 1;
            var sawCount = false;
            while (j < tokens.Count)
            {
                var next = tokens[j];
                if (next.TokenType == TSqlTokenType.WhiteSpace)
                {
                    var nlIdx = next.Text.IndexOfAny(['\r', '\n']);
                    if (nlIdx >= 0)
                    {
                        var endOfLine = nlIdx;
                        if (next.Text[nlIdx] == '\r' && nlIdx + 1 < next.Text.Length && next.Text[nlIdx + 1] == '\n')
                            endOfLine++;
                        afterGo = next.Offset + endOfLine + 1;
                        break;
                    }
                    afterGo = next.Offset + next.Text.Length;
                    j++;
                    continue;
                }
                if (next.TokenType == TSqlTokenType.SingleLineComment)
                {
                    afterGo = next.Offset + next.Text.Length;
                    j++;
                    continue;
                }
                if (next.TokenType == TSqlTokenType.MultilineComment && !next.Text.Contains('\n') && !next.Text.Contains('\r'))
                {
                    afterGo = next.Offset + next.Text.Length;
                    j++;
                    continue;
                }
                if (!sawCount && next.TokenType == TSqlTokenType.Integer)
                {
                    sawCount = true;
                    afterGo = next.Offset + next.Text.Length;
                    j++;
                    continue;
                }
                // Any unexpected non-trivia token on the GO line stays at the start of the next batch so ScriptDom flags it.
                break;
            }
            batchStart = Math.Min(textLength, afterGo);
            i = Math.Max(i, j - 1);
        }

        if (batchStart < textLength)
            batches.Add(new BatchSpan(batchStart, textLength));

        return batches;
    }

    private static LanguageRange MapErrorRange(LineIndex lines, string text, int batchBaseOffset, ParseError error, IList<TSqlParserToken> batchTokens)
    {
        var relOffset = Math.Clamp(error.Offset, 0, Math.Max(0, text.Length - batchBaseOffset));
        var globalStart = Math.Clamp(batchBaseOffset + relOffset, 0, text.Length);
        var globalEnd = globalStart;

        // Highlight the offending token if one starts at or contains relOffset (capped to a single line).
        for (var i = 0; i < batchTokens.Count; i++)
        {
            var tok = batchTokens[i];
            if (tok.TokenType == TSqlTokenType.EndOfFile) break;
            var tokLen = tok.Text?.Length ?? 0;
            if (tok.Offset > relOffset) break;
            if (relOffset >= tok.Offset && relOffset < tok.Offset + tokLen)
            {
                if (tok.TokenType != TSqlTokenType.WhiteSpace)
                {
                    var end = Math.Min(text.Length, batchBaseOffset + tok.Offset + tokLen);
                    // Cap range to the end of the start line so unclosed multi-line tokens don't paint the whole file.
                    var nl = text.IndexOfAny(['\r', '\n'], globalStart, end - globalStart);
                    globalEnd = nl >= 0 ? nl : end;
                }
                break;
            }
        }

        if (globalEnd <= globalStart && globalStart < text.Length && text[globalStart] is not ('\r' or '\n'))
            globalEnd = globalStart + 1;

        return lines.RangeOf(globalStart, globalEnd - globalStart);
    }

    private sealed class LineIndex
    {
        private readonly int[] starts;
        private readonly int[] lengths;
        private readonly int textLength;

        public LineIndex(string text)
        {
            textLength = text.Length;
            var s = new List<int> { 0 };
            var l = new List<int>();
            var start = 0;
            for (var at = 0; at < text.Length; at++)
            {
                if (text[at] is not ('\r' or '\n')) continue;
                l.Add(at - start);
                if (text[at] == '\r' && at + 1 < text.Length && text[at + 1] == '\n') at++;
                start = at + 1;
                s.Add(start);
            }
            l.Add(text.Length - start);
            starts = [.. s];
            lengths = [.. l];
        }

        public LanguagePosition PositionOf(int offset)
        {
            offset = Math.Clamp(offset, 0, textLength);
            var idx = Array.BinarySearch(starts, offset);
            if (idx < 0) idx = Math.Max(0, (~idx) - 1);
            var ch = Math.Clamp(offset - starts[idx], 0, lengths[idx]);
            return new LanguagePosition(idx, ch);
        }

        public LanguageRange RangeOf(int startOffset, int length)
        {
            var s = Math.Clamp(startOffset, 0, textLength);
            var e = Math.Clamp(s + Math.Max(0, length), s, textLength);
            var startPos = PositionOf(s);
            var endPos = PositionOf(e);
            if (endPos.Line < startPos.Line || (endPos.Line == startPos.Line && endPos.Character < startPos.Character))
                endPos = startPos;
            return new LanguageRange(startPos, endPos);
        }
    }

    private sealed class DiagnosticCollector(LineIndex lines)
    {
        private readonly List<LanguageDiagnostic> items = [];
        private readonly HashSet<(int Sl, int Sc, int El, int Ec, string Code, string Msg)> seen = [];
        private int totalChars;
        private bool incomplete;

        public bool IsTruncated => incomplete && (items.Count >= TsqlLanguageService.MaxDiagnosticItems || totalChars >= TsqlLanguageService.MaxDiagnosticCharacters);

        public void MarkIncomplete() => incomplete = true;

        public void Add(LanguageRange range, string message, int severity = 1, string? code = null)
        {
            if (string.IsNullOrWhiteSpace(message)) return;
            if (items.Count >= TsqlLanguageService.MaxDiagnosticItems)
            {
                incomplete = true;
                return;
            }
            if (message.Length > TsqlLanguageService.MaxDiagnosticMessageCharacters)
            {
                message = message[..TsqlLanguageService.MaxDiagnosticMessageCharacters];
                incomplete = true;
            }
            var safeCode = code is { Length: > 128 } ? code[..128] : code;
            var key = (range.Start.Line, range.Start.Character, range.End.Line, range.End.Character, safeCode ?? "", message);
            if (!seen.Add(key)) return;

            var delta = message.Length + (safeCode?.Length ?? 0) + DiagnosticSource.Length;
            if (totalChars + delta > TsqlLanguageService.MaxDiagnosticCharacters)
            {
                incomplete = true;
                return;
            }
            totalChars += delta;
            items.Add(new LanguageDiagnostic(range, message, severity, safeCode, DiagnosticSource));
        }

        public void AddFragment(TSqlFragment fragment, int batchBaseOffset, string message, string code, int severity = 1)
        {
            var range = fragment.StartOffset >= 0 && fragment.FragmentLength >= 0
                ? lines.RangeOf(batchBaseOffset + fragment.StartOffset, fragment.FragmentLength)
                : lines.RangeOf(batchBaseOffset, 0);
            Add(range, message, severity, code);
        }

        public LanguageDiagnosticResult Build(int version) => new(version, items, incomplete);
    }

    private sealed record ScriptLocalTable(
        string Name,
        HashSet<string> Columns,
        bool HasCompleteColumns);

    private sealed class ScriptState(string? activeDatabase)
    {
        public string? ActiveDatabase { get; set; } = activeDatabase;
        public Dictionary<string, ScriptLocalTable> TempTables { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> CreatedObjects { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, ScriptLocalTable> CreatedTables { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> AlteredTables { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> CreatedSchemas { get; } = new(StringComparer.OrdinalIgnoreCase);

        public static string ObjectKey(string? db, string? schema, string name) =>
            $"{db ?? ""}\u0000{schema ?? "dbo"}\u0000{name}";

        public static string SchemaKey(string? db, string schema) =>
            $"{db ?? ""}\u0000{schema}";
    }

    private sealed record BoundSource(
        string ExposureName,
        bool HasExplicitAlias,
        SchemaObjectName? SchemaObject,
        string? ResolvedDatabase,
        string? ResolvedSchema,
        string? ResolvedName,
        bool HasCompleteColumns,
        IReadOnlySet<string> Columns,
        IEqualityComparer<string> Comparer,
        TSqlFragment? AliasFragment);

    private sealed record BoundCte(
        string Name,
        HashSet<string> Columns,
        bool HasCompleteColumns);

    private sealed class QueryScope(
        QueryScope? outer,
        IReadOnlyList<BoundSource> sources,
        IEqualityComparer<string> comparer,
        HashSet<string>? selectAliases = null)
    {
        public QueryScope? Outer { get; } = outer;
        public IReadOnlyList<BoundSource> Sources { get; } = sources;
        public IEqualityComparer<string> Comparer { get; } = comparer;
        public HashSet<string>? SelectAliases { get; } = selectAliases;
        public bool InOrderBy { get; set; }
    }

    private sealed class BindingVisitor(
        IndexLookup? lookup,
        ScriptState state,
        int batchBaseOffset,
        DiagnosticCollector collector,
        CancellationToken cancellationToken) : TSqlFragmentVisitor
    {
        private readonly Dictionary<string, ScriptLocalTable> tableVars = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, BoundCte> visibleCtes = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<QueryDerivedTable, IReadOnlyList<BoundSource>> applyLateralSources = [];
        private readonly Stack<QueryScope?> scopeStack = new();
        private int conditionalDepth;
        private int suppressColumnDepth;
        private BoundSource? triggerTableSource;

        private QueryScope? CurrentScope => scopeStack.Count > 0 ? scopeStack.Peek() : null;

        private IEqualityComparer<string> ActiveComparer(string? dbName = null)
        {
            if (lookup is null) return StringComparer.OrdinalIgnoreCase;
            var targetDb = dbName ?? state.ActiveDatabase;
            if (string.IsNullOrEmpty(targetDb)) return StringComparer.OrdinalIgnoreCase;
            return TsqlCompletionService.CollationComparer(lookup.Database(targetDb));
        }

        private bool IsSystemSchema(string? schema) =>
            string.Equals(schema, "sys", StringComparison.OrdinalIgnoreCase)
            || string.Equals(schema, "INFORMATION_SCHEMA", StringComparison.OrdinalIgnoreCase);

        private bool CanCheckObjects(LookupDatabase db, string? schema)
        {
            if (db.Held is null || db.State is not (LookupState.Ready or LookupState.Partial)) return false;
            if (IsSystemSchema(schema) && db.Gaps.HasFlag(LookupGaps.SystemObjectsLeftOut)) return false;
            return true;
        }

        private bool CanCheckColumns(LookupDatabase db, string? schema)
        {
            if (!CanCheckObjects(db, schema)) return false;
            if (db.Gaps.HasFlag(LookupGaps.ChildrenLeftOut)) return false;
            return true;
        }

        public override void ExplicitVisit(UseStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (node.DatabaseName?.Value is { Length: > 0 } dbName)
                state.ActiveDatabase = dbName;
        }

        public override void ExplicitVisit(CreateSchemaStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (node.Name?.Value is { Length: > 0 } schemaName && state.CreatedSchemas.Count < MaxScriptObjects)
                state.CreatedSchemas.Add(ScriptState.SchemaKey(state.ActiveDatabase, schemaName));
        }

        public override void ExplicitVisit(CreateTableStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var name = node.SchemaObjectName?.BaseIdentifier?.Value;
            if (string.IsNullOrEmpty(name)) return;
            var cols = new HashSet<string>(ActiveComparer(node.SchemaObjectName?.DatabaseIdentifier?.Value));
            if (node.Definition?.ColumnDefinitions is { Count: > 0 } defs)
            {
                foreach (var col in defs)
                    if (col.ColumnIdentifier?.Value is { Length: > 0 } colName) cols.Add(colName);
            }
            var complete = cols.Count > 0 && conditionalDepth == 0;
            if (name.StartsWith('#'))
            {
                if (state.TempTables.Count < MaxLocalTables)
                {
                    if (state.TempTables.TryGetValue(name, out var existing))
                    {
                        var merged = new HashSet<string>(existing.Columns, StringComparer.OrdinalIgnoreCase);
                        merged.UnionWith(cols);
                        state.TempTables[name] = new ScriptLocalTable(name, merged, HasCompleteColumns: false);
                    }
                    else
                    {
                        state.TempTables[name] = new ScriptLocalTable(name, cols, complete);
                    }
                }
            }
            else if (state.CreatedObjects.Count < MaxScriptObjects)
            {
                var db = node.SchemaObjectName?.DatabaseIdentifier?.Value ?? state.ActiveDatabase;
                var schema = node.SchemaObjectName?.SchemaIdentifier?.Value;
                var key = ScriptState.ObjectKey(db, schema, name);
                state.CreatedObjects.Add(key);
                state.CreatedTables[key] = new ScriptLocalTable(name, cols, complete);
            }
        }

        public override void ExplicitVisit(AlterTableAddTableElementStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RecordAlteredTable(node.SchemaObjectName, node.Definition?.ColumnDefinitions);
        }

        public override void ExplicitVisit(AlterTableAlterColumnStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RecordAlteredTable(node.SchemaObjectName, null);
        }

        public override void ExplicitVisit(AlterTableDropTableElementStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RecordAlteredTable(node.SchemaObjectName, null);
        }

        private void RecordAlteredTable(SchemaObjectName? objName, IList<ColumnDefinition>? addedColumns)
        {
            var baseName = objName?.BaseIdentifier?.Value;
            if (string.IsNullOrEmpty(baseName)) return;
            if (baseName.StartsWith('#'))
            {
                if (state.TempTables.TryGetValue(baseName, out var existing))
                {
                    var merged = new HashSet<string>(existing.Columns, StringComparer.OrdinalIgnoreCase);
                    if (addedColumns is not null)
                        foreach (var col in addedColumns)
                            if (col.ColumnIdentifier?.Value is { Length: > 0 } cn) merged.Add(cn);
                    state.TempTables[baseName] = new ScriptLocalTable(baseName, merged, HasCompleteColumns: addedColumns is not null && existing.HasCompleteColumns && conditionalDepth == 0);
                }
                return;
            }
            var db = objName?.DatabaseIdentifier?.Value ?? state.ActiveDatabase;
            var schema = objName?.SchemaIdentifier?.Value;
            var key = ScriptState.ObjectKey(db, schema, baseName);
            state.AlteredTables.Add(key);
        }

        public override void ExplicitVisit(DropTableStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var obj in node.Objects)
            {
                var name = obj.BaseIdentifier?.Value;
                if (!string.IsNullOrEmpty(name) && name.StartsWith('#') && conditionalDepth == 0)
                    state.TempTables.Remove(name);
            }
        }

        public override void ExplicitVisit(CreateViewStatement node) => VisitViewBody(node.SchemaObjectName, node.SelectStatement);
        public override void ExplicitVisit(AlterViewStatement node) => VisitViewBody(node.SchemaObjectName, node.SelectStatement);
        public override void ExplicitVisit(CreateOrAlterViewStatement node) => VisitViewBody(node.SchemaObjectName, node.SelectStatement);

        private void VisitViewBody(SchemaObjectName? name, SelectStatement? select)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RecordCreatedObject(name);
            select?.Accept(this);
        }

        public override void ExplicitVisit(CreateProcedureStatement node) => VisitRoutineBody(node.ProcedureReference?.Name, node.Parameters, null, node.StatementList);
        public override void ExplicitVisit(AlterProcedureStatement node) => VisitRoutineBody(node.ProcedureReference?.Name, node.Parameters, null, node.StatementList);
        public override void ExplicitVisit(CreateOrAlterProcedureStatement node) => VisitRoutineBody(node.ProcedureReference?.Name, node.Parameters, null, node.StatementList);

        public override void ExplicitVisit(CreateFunctionStatement node) => VisitFunctionBody(node.Name, node.Parameters, node.ReturnType, node.StatementList);
        public override void ExplicitVisit(AlterFunctionStatement node) => VisitFunctionBody(node.Name, node.Parameters, node.ReturnType, node.StatementList);
        public override void ExplicitVisit(CreateOrAlterFunctionStatement node) => VisitFunctionBody(node.Name, node.Parameters, node.ReturnType, node.StatementList);

        private void VisitFunctionBody(SchemaObjectName? name, IList<ProcedureParameter>? parameters, FunctionReturnType? returnType, StatementList? body)
        {
            if (returnType is SelectFunctionReturnType inlineTvf)
            {
                RecordCreatedObject(name);
                RegisterParameters(parameters);
                inlineTvf.SelectStatement?.Accept(this);
                return;
            }
            var returnTable = returnType as TableValuedFunctionReturnType;
            VisitRoutineBody(name, parameters, returnTable, body);
        }

        private void VisitRoutineBody(SchemaObjectName? name, IList<ProcedureParameter>? parameters, TableValuedFunctionReturnType? returnTable, StatementList? body)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RecordCreatedObject(name);
            RegisterParameters(parameters);
            if (returnTable?.DeclareTableVariableBody is { } tvBody)
                RegisterTableVariableBody(tvBody);
            body?.Accept(this);
        }

        public override void ExplicitVisit(CreateTriggerStatement node) => VisitTriggerBody(node.Name, node.TriggerObject, node.StatementList);
        public override void ExplicitVisit(AlterTriggerStatement node) => VisitTriggerBody(node.Name, node.TriggerObject, node.StatementList);
        public override void ExplicitVisit(CreateOrAlterTriggerStatement node) => VisitTriggerBody(node.Name, node.TriggerObject, node.StatementList);

        private void VisitTriggerBody(SchemaObjectName? name, TriggerObject? target, StatementList? body)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RecordCreatedObject(name);
            var previous = triggerTableSource;
            if (target?.Name is { } targetObj)
                triggerTableSource = ResolveNamedTableReference(targetObj, alias: null, emitDiagnostics: false, fromSources: null);
            try { body?.Accept(this); }
            finally { triggerTableSource = previous; }
        }

        public override void ExplicitVisit(CreateSynonymStatement node) => RecordCreatedObject(node.Name);
        public override void ExplicitVisit(CreateSequenceStatement node) => RecordCreatedObject(node.Name);
        public override void ExplicitVisit(CreateTypeTableStatement node) => RecordCreatedObject(node.Name);
        public override void ExplicitVisit(CreateTypeUddtStatement node) => RecordCreatedObject(node.Name);

        private void RecordCreatedObject(SchemaObjectName? objName)
        {
            if (objName?.BaseIdentifier?.Value is not { Length: > 0 } name || state.CreatedObjects.Count >= MaxScriptObjects) return;
            var db = objName.DatabaseIdentifier?.Value ?? state.ActiveDatabase;
            var schema = objName.SchemaIdentifier?.Value;
            state.CreatedObjects.Add(ScriptState.ObjectKey(db, schema, name));
        }

        private void RegisterParameters(IList<ProcedureParameter>? parameters)
        {
            if (parameters is null) return;
            foreach (var p in parameters)
                RegisterTypedVariable(p.VariableName?.Value, p.DataType);
        }

        public override void ExplicitVisit(DeclareTableVariableStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (node.Body is not null) RegisterTableVariableBody(node.Body);
        }

        private void RegisterTableVariableBody(DeclareTableVariableBody body)
        {
            var varName = body.VariableName?.Value;
            if (string.IsNullOrEmpty(varName) || tableVars.Count >= MaxLocalTables) return;
            var cols = new HashSet<string>(ActiveComparer());
            if (body.Definition?.ColumnDefinitions is { Count: > 0 } defs)
            {
                foreach (var col in defs)
                    if (col.ColumnIdentifier?.Value is { Length: > 0 } cn) cols.Add(cn);
            }
            tableVars[varName] = new ScriptLocalTable(varName, cols, HasCompleteColumns: cols.Count > 0 && conditionalDepth == 0);
        }

        public override void ExplicitVisit(DeclareVariableStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var decl in node.Declarations)
            {
                RegisterTypedVariable(decl.VariableName?.Value, decl.DataType);
                decl.Value?.Accept(this);
            }
        }

        private void RegisterTypedVariable(string? varName, DataTypeReference? dataType)
        {
            if (string.IsNullOrEmpty(varName) || tableVars.Count >= MaxLocalTables) return;
            if (dataType is UserDataTypeReference udt && udt.Name?.BaseIdentifier?.Value is { Length: > 0 } typeName && lookup is not null)
            {
                var dbName = udt.Name.DatabaseIdentifier?.Value ?? state.ActiveDatabase;
                if (!string.IsNullOrEmpty(dbName))
                {
                    var found = TsqlCompletionService.ResolveCatalogObject(lookup, dbName, udt.Name.SchemaIdentifier?.Value, typeName, TsqlCompletionService.TableTypeKinds, out _);
                    if (found is { } tt)
                    {
                        var db = lookup.Database(tt.Database);
                        var comp = TsqlCompletionService.CollationComparer(db);
                        var cols = new HashSet<string>(comp);
                        foreach (var c in lookup.Columns(tt)) cols.Add(c.Name);
                        tableVars[varName] = new ScriptLocalTable(varName, cols, HasCompleteColumns: !db.Gaps.HasFlag(LookupGaps.ChildrenLeftOut) && cols.Count > 0);
                    }
                }
            }
        }

        public override void ExplicitVisit(IfStatement node)
        {
            node.Predicate?.Accept(this);
            conditionalDepth++;
            try
            {
                node.ThenStatement?.Accept(this);
                node.ElseStatement?.Accept(this);
            }
            finally { conditionalDepth--; }
        }

        public override void ExplicitVisit(WhileStatement node)
        {
            node.Predicate?.Accept(this);
            conditionalDepth++;
            try { node.Statement?.Accept(this); }
            finally { conditionalDepth--; }
        }

        public override void ExplicitVisit(TryCatchStatement node)
        {
            conditionalDepth++;
            try
            {
                node.TryStatements?.Accept(this);
                node.CatchStatements?.Accept(this);
            }
            finally { conditionalDepth--; }
        }

        // Dynamic SQL: never emit false-positive catalog errors inside EXEC / sp_executesql.
        public override void ExplicitVisit(ExecuteStatement node) { }

        public override void ExplicitVisit(SelectStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (lookup is null) return;
            var savedCtes = PushCtes(node.WithCtesAndXmlNamespaces);
            try
            {
                node.QueryExpression?.Accept(this);
                if (node.Into is { BaseIdentifier.Value: { Length: > 0 } intoName })
                    RegisterSelectInto(node.Into, node.QueryExpression);
            }
            finally { RestoreCtes(savedCtes); }
        }

        private void RegisterSelectInto(SchemaObjectName into, QueryExpression? query)
        {
            var baseName = into.BaseIdentifier.Value;
            var (cols, complete) = ProjectQueryColumns(query, explicitCols: null);
            if (baseName.StartsWith('#'))
            {
                if (state.TempTables.Count < MaxLocalTables)
                    state.TempTables[baseName] = new ScriptLocalTable(baseName, cols, complete && conditionalDepth == 0);
            }
            else if (state.CreatedObjects.Count < MaxScriptObjects)
            {
                var db = into.DatabaseIdentifier?.Value ?? state.ActiveDatabase;
                var schema = into.SchemaIdentifier?.Value;
                var key = ScriptState.ObjectKey(db, schema, baseName);
                state.CreatedObjects.Add(key);
                state.CreatedTables[key] = new ScriptLocalTable(baseName, cols, complete && conditionalDepth == 0);
            }
        }

        public override void ExplicitVisit(InsertStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (lookup is null) return;
            var savedCtes = PushCtes(node.WithCtesAndXmlNamespaces);
            try
            {
                if (node.InsertSpecification is not { } spec) return;
                var target = ResolveTableReference(spec.Target, emitDiagnostics: true, fromSources: null);

                // Validate explicit INSERT target column list (only when target has complete known columns).
                if (target is { HasCompleteColumns: true } && spec.Columns.Count > 0)
                {
                    foreach (var col in spec.Columns)
                    {
                        var ids = col.MultiPartIdentifier?.Identifiers;
                        if (ids is not { Count: > 0 }) continue;
                        var colName = ids[^1].Value;
                        if (!target.Columns.Contains(colName))
                            collector.AddFragment(col, batchBaseOffset, $"Invalid column name '{colName}'.", "SQL207");
                    }
                }

                // Visit INSERT source WITHOUT target in SELECT scope.
                spec.InsertSource?.Accept(this);
                spec.TopRowFilter?.Accept(this);

                // Visit OUTPUT clause with `inserted` virtual table bound to target.
                VisitOutputClause(spec.OutputClause, target, includeInserted: true, includeDeleted: false, outerSources: []);
                VisitOutputIntoClause(spec.OutputIntoClause, target, includeInserted: true, includeDeleted: false, outerSources: []);
            }
            finally { RestoreCtes(savedCtes); }
        }

        public override void ExplicitVisit(UpdateStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (lookup is null) return;
            var savedCtes = PushCtes(node.WithCtesAndXmlNamespaces);
            try
            {
                if (node.UpdateSpecification is not { } spec) return;
                var sources = new List<BoundSource>();
                if (spec.FromClause is not null)
                {
                    foreach (var tr in spec.FromClause.TableReferences)
                        CollectFromSources(tr, sources, emitDiagnostics: true);
                }
                CheckDuplicateAliases(sources);

                var target = ResolveDmlTarget(spec.Target, sources, emitDiagnostics: true);
                if (target is not null && !sources.Any(s => s.Comparer.Equals(s.ExposureName, target.ExposureName)))
                    sources.Insert(0, target);

                var scope = new QueryScope(CurrentScope, sources, ActiveComparer());
                scopeStack.Push(scope);
                try
                {
                    spec.TopRowFilter?.Accept(this);
                    if (spec.FromClause is not null) VisitFromClauseChildren(spec.FromClause);
                    foreach (var setClause in spec.SetClauses)
                    {
                        if (setClause is AssignmentSetClause assign)
                        {
                            if (assign.Column is not null)
                                ValidateUpdateSetColumn(assign.Column, target, scope);
                            assign.NewValue?.Accept(this);
                        }
                        else
                        {
                            setClause.Accept(this);
                        }
                    }
                    spec.WhereClause?.Accept(this);
                    VisitOutputClause(spec.OutputClause, target, includeInserted: true, includeDeleted: true, outerSources: sources);
                    VisitOutputIntoClause(spec.OutputIntoClause, target, includeInserted: true, includeDeleted: true, outerSources: sources);
                }
                finally { scopeStack.Pop(); }
            }
            finally { RestoreCtes(savedCtes); }
        }

        private void ValidateUpdateSetColumn(ColumnReferenceExpression col, BoundSource? target, QueryScope scope)
        {
            var ids = col.MultiPartIdentifier?.Identifiers;
            if (ids is null || ids.Count == 0 || col.ColumnType != ColumnType.Regular) return;
            if (ids.Count == 1)
            {
                var name = ids[0].Value;
                if (name.StartsWith('$')) return;
                if (target is { HasCompleteColumns: true } && !target.Columns.Contains(name))
                    collector.AddFragment(col, batchBaseOffset, $"Invalid column name '{name}'.", "SQL207");
                return;
            }
            CheckColumnReference(col, scope);
        }

        public override void ExplicitVisit(DeleteStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (lookup is null) return;
            var savedCtes = PushCtes(node.WithCtesAndXmlNamespaces);
            try
            {
                if (node.DeleteSpecification is not { } spec) return;
                var sources = new List<BoundSource>();
                if (spec.FromClause is not null)
                {
                    foreach (var tr in spec.FromClause.TableReferences)
                        CollectFromSources(tr, sources, emitDiagnostics: true);
                }
                CheckDuplicateAliases(sources);

                var target = ResolveDmlTarget(spec.Target, sources, emitDiagnostics: true);
                if (target is not null && !sources.Any(s => s.Comparer.Equals(s.ExposureName, target.ExposureName)))
                    sources.Insert(0, target);

                var scope = new QueryScope(CurrentScope, sources, ActiveComparer());
                scopeStack.Push(scope);
                try
                {
                    spec.TopRowFilter?.Accept(this);
                    if (spec.FromClause is not null) VisitFromClauseChildren(spec.FromClause);
                    spec.WhereClause?.Accept(this);
                    VisitOutputClause(spec.OutputClause, target, includeInserted: false, includeDeleted: true, outerSources: sources);
                    VisitOutputIntoClause(spec.OutputIntoClause, target, includeInserted: false, includeDeleted: true, outerSources: sources);
                }
                finally { scopeStack.Pop(); }
            }
            finally { RestoreCtes(savedCtes); }
        }

        public override void ExplicitVisit(MergeStatement node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (lookup is null) return;
            var savedCtes = PushCtes(node.WithCtesAndXmlNamespaces);
            try
            {
                if (node.MergeSpecification is not { } spec) return;
                var sources = new List<BoundSource>();
                BoundSource? target = null;
                if (spec.Target is NamedTableReference namedTarget)
                {
                    target = ResolveNamedTableReference(namedTarget.SchemaObject, spec.TableAlias ?? namedTarget.Alias, emitDiagnostics: true, fromSources: null);
                    sources.Add(target);
                }
                else if (spec.Target is not null)
                {
                    target = ResolveTableReference(spec.Target, emitDiagnostics: true, fromSources: null);
                    if (target is not null) sources.Add(target);
                }
                if (spec.TableReference is not null)
                    CollectFromSources(spec.TableReference, sources, emitDiagnostics: true);
                CheckDuplicateAliases(sources);

                var scope = new QueryScope(CurrentScope, sources, ActiveComparer());
                scopeStack.Push(scope);
                try
                {
                    if (spec.TableReference is not null) VisitTableReferenceChildren(spec.TableReference);
                    spec.SearchCondition?.Accept(this);
                    foreach (var actionClause in spec.ActionClauses)
                    {
                        actionClause.SearchCondition?.Accept(this);
                        if (actionClause.Action is UpdateMergeAction upd)
                        {
                            foreach (var sc in upd.SetClauses)
                            {
                                if (sc is AssignmentSetClause assign)
                                {
                                    if (assign.Column is not null) ValidateUpdateSetColumn(assign.Column, target, scope);
                                    assign.NewValue?.Accept(this);
                                }
                                else sc.Accept(this);
                            }
                        }
                        else if (actionClause.Action is InsertMergeAction ins)
                        {
                            if (target is { HasCompleteColumns: true })
                            {
                                foreach (var col in ins.Columns)
                                {
                                    var ids = col.MultiPartIdentifier?.Identifiers;
                                    if (ids is { Count: > 0 } && !target.Columns.Contains(ids[^1].Value))
                                        collector.AddFragment(col, batchBaseOffset, $"Invalid column name '{ids[^1].Value}'.", "SQL207");
                                }
                            }
                            ins.Source?.Accept(this);
                        }
                    }
                    VisitOutputClause(spec.OutputClause, target, includeInserted: true, includeDeleted: true, outerSources: sources);
                    VisitOutputIntoClause(spec.OutputIntoClause, target, includeInserted: true, includeDeleted: true, outerSources: sources);
                }
                finally { scopeStack.Pop(); }
            }
            finally { RestoreCtes(savedCtes); }
        }

        private void VisitOutputClause(OutputClause? clause, BoundSource? target, bool includeInserted, bool includeDeleted, IReadOnlyList<BoundSource> outerSources)
        {
            if (clause is null) return;
            var sources = BuildOutputSources(target, includeInserted, includeDeleted, outerSources);
            scopeStack.Push(new QueryScope(CurrentScope, sources, ActiveComparer()));
            try
            {
                foreach (var el in clause.SelectColumns) el.Accept(this);
            }
            finally { scopeStack.Pop(); }
        }

        private void VisitOutputIntoClause(OutputIntoClause? clause, BoundSource? target, bool includeInserted, bool includeDeleted, IReadOnlyList<BoundSource> outerSources)
        {
            if (clause is null) return;
            var sources = BuildOutputSources(target, includeInserted, includeDeleted, outerSources);
            scopeStack.Push(new QueryScope(CurrentScope, sources, ActiveComparer()));
            try
            {
                foreach (var el in clause.SelectColumns) el.Accept(this);
            }
            finally { scopeStack.Pop(); }
        }

        private List<BoundSource> BuildOutputSources(BoundSource? target, bool includeInserted, bool includeDeleted, IReadOnlyList<BoundSource> outerSources)
        {
            var sources = new List<BoundSource>(outerSources.Count + 2);
            var fallbackTarget = target ?? new BoundSource("target", false, null, null, null, null, false, new HashSet<string>(StringComparer.OrdinalIgnoreCase), StringComparer.OrdinalIgnoreCase, null);
            if (includeInserted)
                sources.Add(fallbackTarget with { ExposureName = "inserted", HasExplicitAlias = true, AliasFragment = null });
            if (includeDeleted)
                sources.Add(fallbackTarget with { ExposureName = "deleted", HasExplicitAlias = true, AliasFragment = null });
            sources.AddRange(outerSources);
            return sources;
        }

        public override void ExplicitVisit(BinaryQueryExpression node)
        {
            node.FirstQueryExpression?.Accept(this);
            node.SecondQueryExpression?.Accept(this);
            if (node.OrderByClause is not null)
            {
                // ORDER BY on UNION/INTERSECT/EXCEPT refers to the first query's output columns; suppress to avoid false positives.
                suppressColumnDepth++;
                try { node.OrderByClause.Accept(this); }
                finally { suppressColumnDepth--; }
            }
        }

        public override void ExplicitVisit(QuerySpecification node)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (lookup is null) return;

            var sources = new List<BoundSource>();
            if (node.FromClause is not null)
            {
                foreach (var tr in node.FromClause.TableReferences)
                    CollectFromSources(tr, sources, emitDiagnostics: true);
            }
            CheckDuplicateAliases(sources);

            var comp = ActiveComparer();
            HashSet<string>? selectAliases = null;
            foreach (var el in node.SelectElements)
            {
                if (el is SelectScalarExpression { ColumnName.Value: { Length: > 0 } alias })
                {
                    selectAliases ??= new HashSet<string>(comp);
                    selectAliases.Add(alias);
                }
            }

            var scope = new QueryScope(CurrentScope, sources, comp, selectAliases);
            scopeStack.Push(scope);
            try
            {
                if (node.FromClause is not null) VisitFromClauseChildren(node.FromClause);
                node.TopRowFilter?.Accept(this);
                foreach (var el in node.SelectElements) el.Accept(this);
                node.WhereClause?.Accept(this);
                node.GroupByClause?.Accept(this);
                node.HavingClause?.Accept(this);
                node.WindowClause?.Accept(this);
                if (node.OrderByClause is not null)
                {
                    scope.InOrderBy = true;
                    try { node.OrderByClause.Accept(this); }
                    finally { scope.InOrderBy = false; }
                }
                node.OffsetClause?.Accept(this);
                // Intentionally skip node.ForClause (FOR JSON / FOR XML directives).
            }
            finally { scopeStack.Pop(); }
        }

        private void VisitFromClauseChildren(FromClause fromClause)
        {
            foreach (var tr in fromClause.TableReferences)
                VisitTableReferenceChildren(tr);
        }

        private void VisitTableReferenceChildren(TableReference tr)
        {
            switch (tr)
            {
                case QualifiedJoin qj:
                    VisitTableReferenceChildren(qj.FirstTableReference);
                    VisitTableReferenceChildren(qj.SecondTableReference);
                    qj.SearchCondition?.Accept(this);
                    break;
                case UnqualifiedJoin uj:
                    VisitTableReferenceChildren(uj.FirstTableReference);
                    if (uj.UnqualifiedJoinType is UnqualifiedJoinType.CrossApply or UnqualifiedJoinType.OuterApply
                        && uj.SecondTableReference is QueryDerivedTable lateral)
                    {
                        var leftSources = new List<BoundSource>();
                        CollectFromSources(uj.FirstTableReference, leftSources, emitDiagnostics: false);
                        applyLateralSources[lateral] = leftSources;
                        try { VisitTableReferenceChildren(uj.SecondTableReference); }
                        finally { applyLateralSources.Remove(lateral); }
                    }
                    else
                    {
                        VisitTableReferenceChildren(uj.SecondTableReference);
                    }
                    break;
                case JoinParenthesisTableReference paren:
                    VisitTableReferenceChildren(paren.Join);
                    break;
                case QueryDerivedTable derived:
                    VisitDerivedTable(derived);
                    break;
                case PivotedTableReference pivoted:
                    VisitTableReferenceChildren(pivoted.TableReference);
                    break;
                case UnpivotedTableReference unpivoted:
                    VisitTableReferenceChildren(unpivoted.TableReference);
                    break;
                case SchemaObjectFunctionTableReference tvf:
                    foreach (var p in tvf.Parameters) p.Accept(this);
                    break;
                case GlobalFunctionTableReference gtvf:
                    foreach (var p in gtvf.Parameters) p.Accept(this);
                    break;
                case OpenJsonTableReference oj:
                    oj.Variable?.Accept(this);
                    oj.RowPattern?.Accept(this);
                    break;
            }
        }

        private void VisitDerivedTable(QueryDerivedTable derived)
        {
            // A non-APPLY derived table cannot see sibling tables from its enclosing FROM clause (skip immediate enclosing QueryScope),
            // whereas CROSS/OUTER APPLY can see its left-hand lateral sources plus outer enclosing queries!
            var enclosing = CurrentScope;
            var outerForDerived = enclosing?.Outer;
            if (applyLateralSources.TryGetValue(derived, out var lateral))
                outerForDerived = new QueryScope(outerForDerived, lateral, ActiveComparer());

            scopeStack.Push(outerForDerived);
            try { derived.QueryExpression?.Accept(this); }
            finally { scopeStack.Pop(); }
        }

        public override void ExplicitVisit(FunctionCall node)
        {
            var fnName = node.FunctionName?.Value;
            if (!string.IsNullOrEmpty(fnName) && TsqlCatalog.DatePartFunctions.Contains(fnName))
            {
                for (var i = 1; i < node.Parameters.Count; i++)
                    node.Parameters[i].Accept(this);
                node.OverClause?.Accept(this);
                return;
            }
            base.ExplicitVisit(node);
        }

        public override void ExplicitVisit(NextValueForExpression node) { }
        public override void ExplicitVisit(ForClause node) { }
        public override void ExplicitVisit(SqlDataTypeReference node) { }
        public override void ExplicitVisit(UserDataTypeReference node) { }

        public override void ExplicitVisit(AtTimeZoneCall node)
        {
            node.DateValue?.Accept(this);
            // Skip node.TimeZone (time zone name expression).
        }

        public override void ExplicitVisit(ColumnReferenceExpression node)
        {
            if (lookup is null || suppressColumnDepth > 0 || collector.IsTruncated) return;
            var scope = CurrentScope;
            if (scope is null) return;
            CheckColumnReference(node, scope);
        }

        private void CheckColumnReference(ColumnReferenceExpression node, QueryScope scope)
        {
            if (node.ColumnType != ColumnType.Regular) return;
            var ids = node.MultiPartIdentifier?.Identifiers;
            if (ids is null || ids.Count == 0) return;

            // Suppress SQL Server pseudo-columns ($IDENTITY, $ROWGUID, $ACTION, $PARTITION, $node_id, $edge_id, $from_id, $to_id).
            foreach (var id in ids)
                if (id.Value.StartsWith('$')) return;

            // Only bind columns inside queries that actually have at least one source (inner or correlated outer).
            if (!HasAnySource(scope)) return;

            if (ids.Count == 1)
            {
                CheckUnqualifiedColumn(node, ids[0].Value, scope);
                return;
            }

            if (ids.Count == 2)
            {
                CheckTwoPartColumn(node, ids[0], ids[1], scope);
                return;
            }

            if (ids.Count == 3)
            {
                CheckThreePartColumn(node, ids[0], ids[1], ids[2], scope);
                return;
            }

            if (ids.Count == 4)
            {
                CheckFourPartColumn(node, ids[0], ids[1], ids[2], ids[3], scope);
            }
        }

        private static bool HasAnySource(QueryScope? scope)
        {
            for (var s = scope; s is not null; s = s.Outer)
                if (s.Sources.Count > 0) return true;
            return false;
        }

        private void CheckUnqualifiedColumn(ColumnReferenceExpression node, string colName, QueryScope scope)
        {
            if (scope.InOrderBy && scope.SelectAliases is not null && scope.SelectAliases.Contains(colName))
                return;

            var cur = scope;
            while (cur is not null)
            {
                var matches = 0;
                var allComplete = true;
                foreach (var src in cur.Sources)
                {
                    if (!src.HasCompleteColumns)
                    {
                        allComplete = false;
                        continue;
                    }
                    if (src.Columns.Contains(colName))
                        matches++;
                }

                if (matches >= 2)
                {
                    collector.AddFragment(node, batchBaseOffset, $"Ambiguous column name '{colName}'.", "SQL209");
                    return;
                }
                if (matches == 1) return;
                if (!allComplete) return; // An unresolved/partial source at this level could own the column!
                cur = cur.Outer;
            }

            collector.AddFragment(node, batchBaseOffset, $"Invalid column name '{colName}'.", "SQL207");
        }

        private void CheckTwoPartColumn(ColumnReferenceExpression node, Identifier qualId, Identifier colId, QueryScope scope)
        {
            var qual = qualId.Value;
            var colName = colId.Value;

            // 1. Search current scope, then enclosing correlated scopes for matching exposure name.
            for (var cur = scope; cur is not null; cur = cur.Outer)
            {
                var matched = cur.Sources.Where(s => s.Comparer.Equals(s.ExposureName, qual)).ToList();
                if (matched.Count > 1) return; // Duplicate alias already flagged; don't cascade.
                if (matched.Count == 1)
                {
                    var src = matched[0];
                    if (!src.HasCompleteColumns) return;
                    if (!src.Columns.Contains(colName))
                        collector.AddFragment(colId, batchBaseOffset, $"Invalid column name '{colName}'.", "SQL207");
                    return;
                }
            }

            // 2. Allow UDT / geometry / geography / hierarchyid property access on an unqualified column (`Location.Lat`).
            for (var cur = scope; cur is not null; cur = cur.Outer)
            {
                foreach (var src in cur.Sources)
                {
                    if (!src.HasCompleteColumns || src.Columns.Contains(qual))
                    {
                        // If `qual` is a real column of an in-scope source, suppress (UDT property access).
                        if (src.Columns.Contains(qual)) return;
                    }
                }
            }

            collector.AddFragment(qualId, batchBaseOffset, $"The multi-part identifier \"{qual}.{colName}\" could not be bound.", "SQL4104");
        }

        private void CheckThreePartColumn(ColumnReferenceExpression node, Identifier p0, Identifier p1, Identifier p2, QueryScope scope)
        {
            // Case A: `schema.table.column` referencing an unaliased table in scope.
            for (var cur = scope; cur is not null; cur = cur.Outer)
            {
                var matched = cur.Sources.Where(s =>
                    !s.HasExplicitAlias
                    && s.SchemaObject is not null
                    && s.Comparer.Equals(s.ResolvedName ?? s.ExposureName, p1.Value)
                    && (s.ResolvedSchema is null || s.Comparer.Equals(s.ResolvedSchema, p0.Value))).ToList();
                if (matched.Count > 1) return;
                if (matched.Count == 1)
                {
                    var src = matched[0];
                    if (!src.HasCompleteColumns) return;
                    if (!src.Columns.Contains(p2.Value))
                        collector.AddFragment(p2, batchBaseOffset, $"Invalid column name '{p2.Value}'.", "SQL207");
                    return;
                }
            }

            // Case B: `alias.udtCol.Prop` (property access on a qualified column).
            for (var cur = scope; cur is not null; cur = cur.Outer)
            {
                var matched = cur.Sources.Where(s => s.Comparer.Equals(s.ExposureName, p0.Value)).ToList();
                if (matched.Count == 1)
                {
                    var src = matched[0];
                    if (!src.HasCompleteColumns || src.Columns.Contains(p1.Value)) return;
                    collector.AddFragment(p1, batchBaseOffset, $"Invalid column name '{p1.Value}'.", "SQL207");
                    return;
                }
            }

            collector.AddFragment(node, batchBaseOffset, $"The multi-part identifier \"{p0.Value}.{p1.Value}.{p2.Value}\" could not be bound.", "SQL4104");
        }

        private void CheckFourPartColumn(ColumnReferenceExpression node, Identifier dbId, Identifier schemaId, Identifier tableId, Identifier colId, QueryScope scope)
        {
            for (var cur = scope; cur is not null; cur = cur.Outer)
            {
                var matched = cur.Sources.Where(s =>
                    !s.HasExplicitAlias
                    && s.SchemaObject is not null
                    && s.Comparer.Equals(s.ResolvedName ?? s.ExposureName, tableId.Value)
                    && (string.IsNullOrEmpty(schemaId.Value) || s.ResolvedSchema is null || s.Comparer.Equals(s.ResolvedSchema, schemaId.Value))
                    && (s.ResolvedDatabase is null || string.Equals(s.ResolvedDatabase, dbId.Value, StringComparison.OrdinalIgnoreCase))).ToList();
                if (matched.Count == 1)
                {
                    var src = matched[0];
                    if (!src.HasCompleteColumns) return;
                    if (!src.Columns.Contains(colId.Value))
                        collector.AddFragment(colId, batchBaseOffset, $"Invalid column name '{colId.Value}'.", "SQL207");
                    return;
                }
            }
            // Do not flag 4-part names as errors when unmatched (could be linked-server or UDT property chain).
        }

        private void CheckDuplicateAliases(List<BoundSource> sources)
        {
            if (sources.Count < 2) return;
            var seen = new HashSet<string>(ActiveComparer());
            foreach (var src in sources)
            {
                if (string.IsNullOrEmpty(src.ExposureName)) continue;
                if (!seen.Add(src.ExposureName) && src.AliasFragment is not null)
                {
                    collector.AddFragment(
                        src.AliasFragment,
                        batchBaseOffset,
                        $"The objects or aliases in the FROM clause have the same exposed name '{src.ExposureName}'. Use correlation names to distinguish them.",
                        "SQL1013");
                }
            }
        }

        private Dictionary<string, BoundCte>? PushCtes(WithCtesAndXmlNamespaces? withClause)
        {
            if (withClause is null || withClause.CommonTableExpressions.Count == 0) return null;
            var saved = new Dictionary<string, BoundCte>(visibleCtes, StringComparer.OrdinalIgnoreCase);
            foreach (var cte in withClause.CommonTableExpressions)
            {
                var cteName = cte.ExpressionName?.Value;
                if (string.IsNullOrEmpty(cteName)) continue;

                // Register stub before visiting body so recursive CTEs referencing themselves never trigger unknown-object errors!
                var explicitCols = cte.Columns?.Select(c => c.Value).Where(v => !string.IsNullOrEmpty(v)).ToList();
                var stubCols = explicitCols is { Count: > 0 }
                    ? new HashSet<string>(explicitCols, ActiveComparer())
                    : new HashSet<string>(ActiveComparer());
                visibleCtes[cteName] = new BoundCte(cteName, stubCols, HasCompleteColumns: explicitCols is { Count: > 0 });

                // CTE bodies cannot see outer query sources; push a null scope barrier.
                scopeStack.Push(null);
                try { cte.QueryExpression?.Accept(this); }
                finally { scopeStack.Pop(); }

                var (projCols, complete) = ProjectQueryColumns(cte.QueryExpression, explicitCols);
                visibleCtes[cteName] = new BoundCte(cteName, projCols, complete);
            }
            return saved;
        }

        private void RestoreCtes(Dictionary<string, BoundCte>? saved)
        {
            if (saved is null) return;
            visibleCtes.Clear();
            foreach (var (k, v) in saved) visibleCtes[k] = v;
        }

        private (HashSet<string> Columns, bool HasCompleteColumns) ProjectQueryColumns(QueryExpression? query, IReadOnlyList<string>? explicitCols)
        {
            var comp = ActiveComparer();
            if (explicitCols is { Count: > 0 })
                return (new HashSet<string>(explicitCols, comp), true);

            var spec = FirstQuerySpecification(query);
            if (spec is null) return (new HashSet<string>(comp), false);

            var fromSources = new List<BoundSource>();
            if (spec.FromClause is not null)
            {
                foreach (var tr in spec.FromClause.TableReferences)
                    CollectFromSources(tr, fromSources, emitDiagnostics: false);
            }

            var cols = new HashSet<string>(comp);
            var complete = true;
            foreach (var element in spec.SelectElements)
            {
                switch (element)
                {
                    case SelectStarExpression star:
                        if (star.Qualifier?.Identifiers is { Count: > 0 } q)
                        {
                            var qName = q[^1].Value;
                            var matched = fromSources.FirstOrDefault(s => s.Comparer.Equals(s.ExposureName, qName));
                            if (matched is { HasCompleteColumns: true }) cols.UnionWith(matched.Columns);
                            else complete = false;
                        }
                        else if (fromSources.Count > 0)
                        {
                            foreach (var src in fromSources)
                            {
                                if (src.HasCompleteColumns) cols.UnionWith(src.Columns);
                                else complete = false;
                            }
                        }
                        else
                        {
                            complete = false;
                        }
                        break;

                    case SelectScalarExpression scalar:
                        var name = scalar.ColumnName?.Value;
                        if (string.IsNullOrEmpty(name) && scalar.Expression is ColumnReferenceExpression colRef
                            && colRef.MultiPartIdentifier?.Identifiers is { Count: > 0 } ids)
                        {
                            name = ids[^1].Value;
                        }
                        if (!string.IsNullOrEmpty(name)) cols.Add(name);
                        else complete = false;
                        break;

                    default:
                        complete = false;
                        break;
                }
            }
            return (cols, complete && cols.Count > 0);
        }

        private static QuerySpecification? FirstQuerySpecification(QueryExpression? expr) => expr switch
        {
            QuerySpecification spec => spec,
            BinaryQueryExpression bin => FirstQuerySpecification(bin.FirstQueryExpression),
            QueryParenthesisExpression paren => FirstQuerySpecification(paren.QueryExpression),
            _ => null
        };

        private BoundSource? ResolveDmlTarget(TableReference? target, IReadOnlyList<BoundSource> fromSources, bool emitDiagnostics)
        {
            if (target is NamedTableReference named)
                return ResolveNamedTableReference(named.SchemaObject, named.Alias, emitDiagnostics, fromSources);
            return ResolveTableReference(target, emitDiagnostics, fromSources);
        }

        private void CollectFromSources(TableReference? tr, List<BoundSource> output, bool emitDiagnostics)
        {
            if (tr is null) return;
            switch (tr)
            {
                case JoinTableReference join:
                    CollectFromSources(join.FirstTableReference, output, emitDiagnostics);
                    CollectFromSources(join.SecondTableReference, output, emitDiagnostics);
                    break;
                case JoinParenthesisTableReference paren:
                    CollectFromSources(paren.Join, output, emitDiagnostics);
                    break;
                default:
                    var resolved = ResolveTableReference(tr, emitDiagnostics, fromSources: null);
                    if (resolved is not null) output.Add(resolved);
                    break;
            }
        }

        private BoundSource? ResolveTableReference(TableReference? tr, bool emitDiagnostics, IReadOnlyList<BoundSource>? fromSources)
        {
            if (tr is null) return null;
            var comp = ActiveComparer();
            switch (tr)
            {
                case NamedTableReference named:
                    return ResolveNamedTableReference(named.SchemaObject, named.Alias, emitDiagnostics, fromSources);

                case VariableTableReference vt:
                {
                    var varName = vt.Variable.Name;
                    var exposure = vt.Alias?.Value ?? varName;
                    if (tableVars.TryGetValue(varName, out var tv))
                        return new BoundSource(exposure, vt.Alias is not null, null, null, null, null, tv.HasCompleteColumns, tv.Columns, comp, vt.Alias ?? (TSqlFragment)vt.Variable);
                    return new BoundSource(exposure, vt.Alias is not null, null, null, null, null, false, new HashSet<string>(comp), comp, vt.Alias ?? (TSqlFragment)vt.Variable);
                }

                case QueryDerivedTable derived:
                {
                    var explicitCols = derived.Columns?.Select(c => c.Value).Where(v => !string.IsNullOrEmpty(v)).ToList();
                    var (cols, complete) = ProjectQueryColumns(derived.QueryExpression, explicitCols);
                    var exposure = derived.Alias?.Value ?? "";
                    return new BoundSource(exposure, derived.Alias is not null, null, null, null, null, complete, cols, comp, derived.Alias);
                }

                case PivotedTableReference pivoted:
                {
                    // Still check the inner source object validity, but mark PIVOT output columns incomplete so PIVOT never false-positives.
                    var inner = new List<BoundSource>();
                    CollectFromSources(pivoted.TableReference, inner, emitDiagnostics);
                    return new BoundSource(pivoted.Alias?.Value ?? "", pivoted.Alias is not null, null, null, null, null, false, new HashSet<string>(comp), comp, pivoted.Alias);
                }

                case UnpivotedTableReference unpivoted:
                {
                    var inner = new List<BoundSource>();
                    CollectFromSources(unpivoted.TableReference, inner, emitDiagnostics);
                    return new BoundSource(unpivoted.Alias?.Value ?? "", unpivoted.Alias is not null, null, null, null, null, false, new HashSet<string>(comp), comp, unpivoted.Alias);
                }

                case OpenJsonTableReference oj:
                {
                    var cols = new HashSet<string>(comp);
                    if (oj.SchemaDeclarationItems.Count > 0)
                    {
                        foreach (var item in oj.SchemaDeclarationItems)
                            if (item.ColumnDefinition?.ColumnIdentifier?.Value is { Length: > 0 } cn) cols.Add(cn);
                    }
                    else
                    {
                        cols.Add("key");
                        cols.Add("value");
                        cols.Add("type");
                    }
                    return new BoundSource(oj.Alias?.Value ?? "OPENJSON", oj.Alias is not null, null, null, null, null, cols.Count > 0, cols, comp, oj.Alias);
                }

                case SchemaObjectFunctionTableReference tvf:
                {
                    // TVF or XML/UDT method call (e.g. `o.XmlCol.nodes('/a') AS x(n)`): never flag as unknown table!
                    var cols = tvf.Columns is { Count: > 0 }
                        ? new HashSet<string>(tvf.Columns.Select(c => c.Value), comp)
                        : new HashSet<string>(comp);
                    var exposure = tvf.Alias?.Value ?? tvf.SchemaObject?.BaseIdentifier?.Value ?? "";
                    return new BoundSource(exposure, tvf.Alias is not null, null, null, null, null, cols.Count > 0, cols, comp, tvf.Alias);
                }

                case TableReferenceWithAliasAndColumns withCols:
                {
                    var cols = withCols.Columns is { Count: > 0 }
                        ? new HashSet<string>(withCols.Columns.Select(c => c.Value), comp)
                        : new HashSet<string>(comp);
                    return new BoundSource(withCols.Alias?.Value ?? "", withCols.Alias is not null, null, null, null, null, cols.Count > 0, cols, comp, withCols.Alias);
                }

                case TableReferenceWithAlias withAlias:
                    return new BoundSource(withAlias.Alias?.Value ?? "", withAlias.Alias is not null, null, null, null, null, false, new HashSet<string>(comp), comp, withAlias.Alias);

                default:
                    return new BoundSource("", false, null, null, null, null, false, new HashSet<string>(comp), comp, null);
            }
        }

        private BoundSource ResolveNamedTableReference(SchemaObjectName objName, Identifier? alias, bool emitDiagnostics, IReadOnlyList<BoundSource>? fromSources)
        {
            var baseName = objName.BaseIdentifier?.Value ?? "";
            var schema = objName.SchemaIdentifier?.Value;
            var dbName = objName.DatabaseIdentifier?.Value;
            var exposure = alias?.Value ?? baseName;
            var aliasFrag = (TSqlFragment?)alias ?? objName;
            var comp = ActiveComparer(dbName);

            // 1. 4-part linked-server name: never flag!
            if (objName.ServerIdentifier is not null)
                return new BoundSource(exposure, alias is not null, objName, dbName, schema, baseName, false, new HashSet<string>(comp), comp, aliasFrag);

            // 2. Single-part local/virtual names: #temp, inserted/deleted, CTE, or UPDATE/DELETE alias target.
            if (dbName is null && schema is null)
            {
                if (baseName.StartsWith('#'))
                {
                    if (state.TempTables.TryGetValue(baseName, out var temp))
                        return new BoundSource(exposure, alias is not null, objName, null, null, baseName, temp.HasCompleteColumns, temp.Columns, StringComparer.OrdinalIgnoreCase, aliasFrag);
                    return new BoundSource(exposure, alias is not null, objName, null, null, baseName, false, new HashSet<string>(StringComparer.OrdinalIgnoreCase), StringComparer.OrdinalIgnoreCase, aliasFrag);
                }

                if (string.Equals(baseName, "inserted", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(baseName, "deleted", StringComparison.OrdinalIgnoreCase))
                {
                    if (triggerTableSource is { } trig)
                        return trig with { ExposureName = exposure, HasExplicitAlias = alias is not null, AliasFragment = aliasFrag };
                    return new BoundSource(exposure, alias is not null, objName, null, null, baseName, false, new HashSet<string>(comp), comp, aliasFrag);
                }

                if (visibleCtes.TryGetValue(baseName, out var cte))
                    return new BoundSource(exposure, alias is not null, objName, null, null, baseName, cte.HasCompleteColumns, cte.Columns, comp, aliasFrag);

                // UPDATE o SET ... FROM dbo.Orders AS o / DELETE o FROM dbo.Orders AS o
                if (fromSources is not null)
                {
                    var fromMatch = fromSources.FirstOrDefault(s => s.Comparer.Equals(s.ExposureName, baseName));
                    if (fromMatch is not null) return fromMatch;
                }
            }

            var targetDb = dbName ?? state.ActiveDatabase;

            // 3. Script-created tables / objects earlier in the same script.
            var createdKey = ScriptState.ObjectKey(targetDb, schema, baseName);
            if (state.CreatedTables.TryGetValue(createdKey, out var createdTable))
            {
                var altered = state.AlteredTables.Contains(createdKey);
                return new BoundSource(exposure, alias is not null, objName, targetDb, schema ?? "dbo", baseName,
                    createdTable.HasCompleteColumns && !altered, createdTable.Columns, comp, aliasFrag);
            }
            if (state.CreatedObjects.Contains(createdKey))
                return new BoundSource(exposure, alias is not null, objName, targetDb, schema ?? "dbo", baseName, false, new HashSet<string>(comp), comp, aliasFrag);

            // 4. Catalog lookup via IndexLookup.
            if (lookup is null || string.IsNullOrEmpty(targetDb))
                return new BoundSource(exposure, alias is not null, objName, targetDb, schema, baseName, false, new HashSet<string>(comp), comp, aliasFrag);

            var db = lookup.Database(targetDb);
            var dbComp = TsqlCompletionService.CollationComparer(db);
            if (!CanCheckObjects(db, schema))
                return new BoundSource(exposure, alias is not null, objName, db.Database, schema, baseName, false, new HashSet<string>(dbComp), dbComp, aliasFrag);

            var answer = lookup.Objects(db.Database, schema, baseName, TableLikeKinds);
            if (answer.Value.Count > 0)
            {
                var chosen = PickBestObject(answer.Value, schema);
                var altered = state.AlteredTables.Contains(ScriptState.ObjectKey(db.Database, chosen.Schema, chosen.Name));
                var checkCols = !altered
                    && CanCheckColumns(db, chosen.Schema)
                    && chosen.Kind is "table" or "view";
                var cols = new HashSet<string>(dbComp);
                if (checkCols)
                {
                    foreach (var c in lookup.Columns(chosen))
                        cols.Add(c.Name);
                }
                var complete = checkCols && cols.Count > 0;
                return new BoundSource(exposure, alias is not null, objName, db.Database, chosen.Schema, chosen.Name, complete, cols, dbComp, aliasFrag);
            }

            // Object was NOT found in an eligible database.
            if (emitDiagnostics)
            {
                if (!string.IsNullOrEmpty(schema) && db.State == LookupState.Ready)
                {
                    var schemas = lookup.Schemas(db.Database);
                    if (schemas.Count > 0
                        && !schemas.Any(s => dbComp.Equals(s, schema))
                        && !state.CreatedSchemas.Contains(ScriptState.SchemaKey(db.Database, schema))
                        && !(IsSystemSchema(schema) && db.Gaps.HasFlag(LookupGaps.SystemObjectsLeftOut)))
                    {
                        collector.AddFragment(
                            (TSqlFragment?)objName.SchemaIdentifier ?? objName,
                            batchBaseOffset,
                            $"Unknown schema '{schema}' in database '{db.Database}'.",
                            "SQL2760");
                        return new BoundSource(exposure, alias is not null, objName, db.Database, schema, baseName, false, new HashSet<string>(dbComp), dbComp, aliasFrag);
                    }
                }

                var displayName = FormatDisplayObjectName(objName);
                collector.AddFragment(objName, batchBaseOffset, $"Invalid object name '{displayName}'.", "SQL208");
            }

            return new BoundSource(exposure, alias is not null, objName, db.Database, schema, baseName, false, new HashSet<string>(dbComp), dbComp, aliasFrag);
        }

        private static LookupObject PickBestObject(IReadOnlyList<LookupObject> matches, string? requestedSchema)
        {
            if (matches.Count == 1) return matches[0];
            static int KindRank(string kind) => kind switch { "table" => 0, "view" => 1, "synonym" => 2, "function" => 3, _ => 4 };
            return matches
                .OrderBy(m => requestedSchema is null && string.Equals(m.Schema, "dbo", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ThenBy(m => KindRank(m.Kind))
                .First();
        }

        private static string FormatDisplayObjectName(SchemaObjectName objName)
        {
            var parts = new List<string>(3);
            if (objName.DatabaseIdentifier?.Value is { Length: > 0 } db) parts.Add(db);
            if (objName.SchemaIdentifier?.Value is { Length: > 0 } sc) parts.Add(sc);
            else if (parts.Count > 0) parts.Add("");
            if (objName.BaseIdentifier?.Value is { Length: > 0 } bn) parts.Add(bn);
            return string.Join('.', parts);
        }
    }
}
