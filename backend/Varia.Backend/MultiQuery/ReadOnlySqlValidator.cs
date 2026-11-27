using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace Varia.Backend.MultiQuery;

/// <summary>Strict AST allowlist validator for T-SQL in Cross-Engine Read-Only mode. Parses every batch in a single
/// <see cref="ResultNames.OnParseThreadAsync{T}"/> call, fails closed on oversize/deeply-nested/syntax-error/comment-only/GO-n
/// scripts, requires top-level statements to be <see cref="SelectStatement"/> with <c>Into == null</c>, and rejects
/// mutating or external-access fragments anywhere in the subtree.</summary>
internal sealed class ReadOnlySqlValidator : IReadOnlySqlValidator
{
    private static readonly Regex InvalidScriptLine = new(@"^Line (\d+):", RegexOptions.CultureInvariant);

    public async Task<IReadOnlyList<ReadOnlySqlViolation>> ValidateTSqlAsync(string sql, int startLine, CancellationToken token)
    {
        var baseLine = Math.Max(1, startLine);
        if (string.IsNullOrWhiteSpace(sql))
            return [new ReadOnlySqlViolation(baseLine, 1, baseLine, 1, "EMPTY", "Cross-engine read-only mode requires at least one SELECT statement.")];

        List<SqlBatch> batches;
        try
        {
            batches = SqlScript.Parse(sql, baseLine);
        }
        catch (RequestException error)
        {
            var line = ExtractLine(error.Message, baseLine);
            return [new ReadOnlySqlViolation(line, 1, line, 1, "SCRIPT", error.Message)];
        }

        if (batches.Count == 0)
            return [new ReadOnlySqlViolation(baseLine, 1, baseLine, 1, "EMPTY", "Cross-engine read-only mode requires at least one SELECT statement.")];

        token.ThrowIfCancellationRequested();

        return await ResultNames.OnParseThreadAsync(() => ValidateBatches(batches, baseLine, token))
            .WaitAsync(token)
            .ConfigureAwait(false);
    }

    private static IReadOnlyList<ReadOnlySqlViolation> ValidateBatches(IReadOnlyList<SqlBatch> batches, int startLine, CancellationToken token)
    {
        var violations = new List<ReadOnlySqlViolation>();
        var parser = new TSql180Parser(initialQuotedIdentifiers: true);

        foreach (var batch in batches)
        {
            token.ThrowIfCancellationRequested();
            var firstLine = startLine + batch.StartLine - 1;

            if (batch.RepeatCount > 1)
            {
                violations.Add(new ReadOnlySqlViolation(
                    firstLine, 1, firstLine, 1, "GO",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch repetition (GO {batch.RepeatCount.ToString(CultureInfo.InvariantCulture)}) is not allowed in cross-engine read-only mode."));
                continue;
            }

            if (batch.Sql.Length > ResultNames.MaxParseChars)
            {
                violations.Add(new ReadOnlySqlViolation(
                    firstLine, 1, firstLine, 1, "BATCH_TOO_LARGE",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch exceeds the {ResultNames.MaxParseChars.ToString("N0", CultureInfo.InvariantCulture)}-character read-only validation limit."));
                continue;
            }

            if (batch.ParenDepth > ResultNames.MaxParenDepth)
            {
                violations.Add(new ReadOnlySqlViolation(
                    firstLine, 1, firstLine, 1, "NESTING_DEPTH",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch exceeds the maximum parenthesis nesting depth ({ResultNames.MaxParenDepth.ToString(CultureInfo.InvariantCulture)}) for read-only validation."));
                continue;
            }

            TSqlFragment? fragment;
            IList<ParseError> errors;
            try
            {
                using var reader = new StringReader(batch.Sql);
                fragment = parser.Parse(reader, out errors);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                violations.Add(new ReadOnlySqlViolation(
                    firstLine, 1, firstLine, 1, "PARSE",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch could not be parsed for read-only validation."));
                continue;
            }

            if (errors.Count > 0)
            {
                foreach (var error in errors)
                {
                    var line = firstLine + Math.Max(1, error.Line) - 1;
                    var col = Math.Max(1, error.Column);
                    violations.Add(new ReadOnlySqlViolation(line, col, line, col, "SYNTAX", error.Message));
                }
                continue;
            }

            if (fragment is not TSqlScript script)
            {
                violations.Add(new ReadOnlySqlViolation(
                    firstLine, 1, firstLine, 1, "PARSE",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch did not parse as a T-SQL script."));
                continue;
            }

            var statements = script.Batches.SelectMany(parsed => parsed.Statements).ToList();
            if (statements.Count == 0)
            {
                violations.Add(new ReadOnlySqlViolation(
                    firstLine, 1, firstLine, 1, "EMPTY",
                    $"Line {firstLine.ToString(CultureInfo.InvariantCulture)}: Batch contains no executable SELECT statements."));
                continue;
            }

            foreach (var statement in statements)
            {
                if (statement is not SelectStatement select)
                {
                    var (line, col, endLine, endCol) = SpanOf(statement, firstLine);
                    var keyword = LeadingKeywordOf(statement);
                    violations.Add(new ReadOnlySqlViolation(
                        line, col, endLine, endCol, keyword,
                        $"Line {line.ToString(CultureInfo.InvariantCulture)}: Only read-only SELECT statements are allowed in cross-engine mode ({keyword} is blocked)."));
                    continue;
                }

                if (select.Into is not null)
                {
                    var (line, col, endLine, endCol) = SpanOf(select.Into, firstLine);
                    violations.Add(new ReadOnlySqlViolation(
                        line, col, endLine, endCol, "SELECT INTO",
                        $"Line {line.ToString(CultureInfo.InvariantCulture)}: SELECT INTO is not allowed in cross-engine read-only mode."));
                }

                var visitor = new SubtreeVisitor(firstLine, violations);
                select.Accept(visitor);
            }
        }

        return violations;
    }

    internal static IReadOnlyList<ReadOnlySqlViolation> InspectSubtree(TSqlFragment fragment, int firstLine)
    {
        var violations = new List<ReadOnlySqlViolation>();
        fragment.Accept(new SubtreeVisitor(firstLine, violations));
        return violations;
    }

    internal static (int Line, int Column, int EndLine, int EndColumn) SpanOf(TSqlFragment fragment, int firstLine)
    {
        var line = firstLine + Math.Max(1, fragment.StartLine) - 1;
        var col = Math.Max(1, fragment.StartColumn);
        var endLine = line;
        var endCol = col + Math.Max(0, fragment.FragmentLength);

        var tokens = fragment.ScriptTokenStream;
        if (tokens is not null && fragment.LastTokenIndex >= 0 && fragment.LastTokenIndex < tokens.Count)
        {
            var last = tokens[fragment.LastTokenIndex];
            var text = last.Text ?? string.Empty;
            var tokenLine = firstLine + Math.Max(1, last.Line) - 1;
            var tokenCol = Math.Max(1, last.Column);
            var breaks = 0;
            var lastBreak = -1;
            for (var i = 0; i < text.Length; i++)
            {
                if (text[i] == '\n')
                {
                    breaks++;
                    lastBreak = i;
                }
                else if (text[i] == '\r' && (i + 1 == text.Length || text[i + 1] != '\n'))
                {
                    breaks++;
                    lastBreak = i;
                }
            }
            if (breaks == 0)
            {
                endLine = tokenLine;
                endCol = tokenCol + text.Length;
            }
            else
            {
                endLine = tokenLine + breaks;
                endCol = 1 + (text.Length - lastBreak - 1);
            }
        }

        return (line, col, endLine, endCol);
    }

    private static string LeadingKeywordOf(TSqlStatement statement)
    {
        var tokens = statement.ScriptTokenStream;
        if (tokens is not null && statement.FirstTokenIndex >= 0 && statement.FirstTokenIndex < tokens.Count)
        {
            var end = Math.Min(statement.LastTokenIndex, tokens.Count - 1);
            for (var i = statement.FirstTokenIndex; i <= end; i++)
            {
                var token = tokens[i];
                if (token.TokenType is TSqlTokenType.WhiteSpace or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment or TSqlTokenType.Semicolon)
                    continue;
                if (!string.IsNullOrWhiteSpace(token.Text))
                    return token.Text.ToUpperInvariant();
            }
        }
        var name = statement.GetType().Name;
        if (name.EndsWith("Statement", StringComparison.Ordinal)) name = name[..^"Statement".Length];
        return name.ToUpperInvariant();
    }

    private static int ExtractLine(string message, int fallback)
    {
        var match = InvalidScriptLine.Match(message);
        return match.Success && int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed
            : fallback;
    }

    private sealed class SubtreeVisitor(int firstLine, List<ReadOnlySqlViolation> violations) : TSqlFragmentVisitor
    {
        private readonly HashSet<TSqlFragment> suppressedSpecs = [];

        public override void Visit(TSqlFragment node)
        {
            switch (node)
            {
                case DataModificationTableReference dmlRef:
                    if (dmlRef.DataModificationSpecification is not null)
                        suppressedSpecs.Add(dmlRef.DataModificationSpecification);
                    Add(dmlRef, "DML_TABLE_SOURCE", "Composable DML (INSERT/UPDATE/DELETE/MERGE ... OUTPUT) is not allowed in cross-engine read-only mode.");
                    break;
                case DataModificationSpecification dmlSpec when !suppressedSpecs.Contains(dmlSpec):
                    Add(dmlSpec, "DML", "Data modification statements are not allowed in cross-engine read-only mode.");
                    break;
                case OpenRowsetTableReference or BulkOpenRowset or OpenRowsetCosmos or InternalOpenRowset:
                    Add(node, "OPENROWSET", "OPENROWSET is not allowed in cross-engine read-only mode.");
                    break;
                case OpenQueryTableReference:
                    Add(node, "OPENQUERY", "OPENQUERY is not allowed in cross-engine read-only mode.");
                    break;
                case AdHocTableReference:
                    Add(node, "OPENDATASOURCE", "OPENDATASOURCE is not allowed in cross-engine read-only mode.");
                    break;
                case OpenXmlTableReference:
                    Add(node, "OPENXML", "OPENXML is not allowed in cross-engine read-only mode.");
                    break;
                case NextValueForExpression:
                    Add(node, "NEXT VALUE FOR", "NEXT VALUE FOR mutates sequence state and is not allowed in cross-engine read-only mode.");
                    break;
                case SelectSetVariable:
                    Add(node, "SELECT_ASSIGNMENT", "Variable assignment (SELECT @var = ...) is not allowed in cross-engine read-only mode.");
                    break;
                case InvokeExternalApiFunctionCall:
                case FunctionCall fc when IsBuiltInOrSysCall(fc) && string.Equals(fc.FunctionName?.Value, "INVOKE_EXTERNAL_API", StringComparison.OrdinalIgnoreCase):
                    Add(node, "INVOKE_EXTERNAL_API", "INVOKE_EXTERNAL_API is not allowed in cross-engine read-only mode.");
                    break;
                case AIGenerateEmbeddingsFunctionCall or AIGenerateResponseFunctionCall or AIAnalyzeSentimentFunctionCall
                    or AIClassifyFunctionCall or AIExtractFunctionCall or AIFixGrammarFunctionCall
                    or AISummarizeFunctionCall or AITranslateFunctionCall:
                case FunctionCall aiFc when IsBuiltInOrSysCall(aiFc) && ExternalAiFunctionNames.Contains(aiFc.FunctionName?.Value ?? ""):
                    Add(node, "EXTERNAL_AI_CALL", "External AI model calls are not allowed in cross-engine read-only mode.");
                    break;
            }
        }

        private static readonly HashSet<string> ExternalAiFunctionNames = new(StringComparer.OrdinalIgnoreCase)
        {
            "AI_GENERATE_EMBEDDINGS", "AI_GENERATE_RESPONSE", "AI_ANALYZE_SENTIMENT",
            "AI_CLASSIFY", "AI_EXTRACT", "AI_FIX_GRAMMAR", "AI_SUMMARIZE", "AI_TRANSLATE"
        };

        private static bool IsBuiltInOrSysCall(FunctionCall fc) =>
            fc.CallTarget is null
            || (fc.CallTarget is MultiPartIdentifierCallTarget mp && mp.MultiPartIdentifier.Count >= 1
                && string.Equals(mp.MultiPartIdentifier[^1].Value, "sys", StringComparison.OrdinalIgnoreCase));

        private void Add(TSqlFragment fragment, string keyword, string detail)
        {
            var (line, col, endLine, endCol) = SpanOf(fragment, firstLine);
            violations.Add(new ReadOnlySqlViolation(
                line, col, endLine, endCol, keyword,
                $"Line {line.ToString(CultureInfo.InvariantCulture)}: {detail}"));
        }
    }
}
