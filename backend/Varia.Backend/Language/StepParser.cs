using Microsoft.SqlServer.TransactSql.ScriptDom;
using Varia.Backend.Agent;

namespace Varia.Backend.Language;

/// <summary>language.parse (AG-6b, src/shared/agent/parse.ts): the job step editor's Parse. ScriptDom's parser alone, like SSMS's Parse, with no
/// connection and nothing executed; the text and the errors are bounded by the Agent catalogue's parseChars and parseErrors.</summary>
internal static class StepParser
{
    /// <summary>src/shared/agent/parse.ts parseMessageChars.</summary>
    public const int MessageChars = 2_048;

    public static async Task<LanguageParseResult> ParseAsync(LanguageParseArgs? args, CancellationToken token)
    {
        var catalog = AgentCatalog.Current;
        if (args?.Text is not { } text || text.Length > catalog.Limit("parseChars")) throw new RequestException("INVALID_PARAMS", "language.parse takes a text of at most " + catalog.Limit("parseChars") + " characters.");
        token.ThrowIfCancellationRequested();
        // ScriptDom's grammar recurses: nesting deeper than SQL Server itself accepts is refused before the parse (a stack overflow ends
        // the process), and the parse runs on ResultNames' large-stack thread so long operator chains cannot overflow it either.
        var parser = new TSql180Parser(initialQuotedIdentifiers: true);
        IList<ParseError> errors;
        using (var lexed = new StringReader(text))
        {
            var tokens = parser.GetTokenStream(lexed, out var lexErrors);
            if (lexErrors.Count == 0 && TooDeep(tokens, out var line, out var column)) return new([new(line, column, 0, $"The text nests parentheses more than {ResultNames.MaxParenDepth} deep, too deep to parse.")], false);
        }
        errors = await ResultNames.OnParseThreadAsync(() =>
        {
            using var reader = new StringReader(text);
            new TSql180Parser(initialQuotedIdentifiers: true).Parse(reader, out var found);
            return found;
        }).WaitAsync(token).ConfigureAwait(false);
        var limit = (int)catalog.Limit("parseErrors");
        var listed = errors.Take(limit).Select(error => new LanguageParseError(Math.Max(1, error.Line), Math.Max(1, error.Column), Math.Max(0, error.Number),
            error.Message.Length > MessageChars ? error.Message[..MessageChars] : error.Message)).ToList();
        return new(listed, errors.Count > limit);
    }

    private static bool TooDeep(IList<TSqlParserToken> tokens, out int line, out int column)
    {
        var depth = 0;
        foreach (var token in tokens)
        {
            if (token.TokenType == TSqlTokenType.LeftParenthesis && ++depth > ResultNames.MaxParenDepth) { line = Math.Max(1, token.Line); column = Math.Max(1, token.Column); return true; }
            if (token.TokenType == TSqlTokenType.RightParenthesis && depth > 0) depth--;
        }
        line = column = 0;
        return false;
    }
}
