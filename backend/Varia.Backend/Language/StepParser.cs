using Microsoft.SqlServer.TransactSql.ScriptDom;
using Varia.Backend.Agent;

namespace Varia.Backend.Language;

/// <summary>language.parse (AG-6b, src/shared/agent/parse.ts): the job step editor's Parse. ScriptDom's parser alone, like SSMS's Parse, with no
/// connection and nothing executed; the text and the errors are bounded by the Agent catalogue's parseChars and parseErrors.</summary>
internal static class StepParser
{
    /// <summary>src/shared/agent/parse.ts parseMessageChars.</summary>
    public const int MessageChars = 2_048;

    public static LanguageParseResult Parse(LanguageParseArgs? args, CancellationToken token)
    {
        var catalog = AgentCatalog.Current;
        if (args?.Text is not { } text || text.Length > catalog.Limit("parseChars")) throw new RequestException("INVALID_PARAMS", "language.parse takes a text of at most " + catalog.Limit("parseChars") + " characters.");
        token.ThrowIfCancellationRequested();
        var parser = new TSql180Parser(initialQuotedIdentifiers: true);
        using var reader = new StringReader(text);
        parser.Parse(reader, out var errors);
        var limit = (int)catalog.Limit("parseErrors");
        var listed = errors.Take(limit).Select(error => new LanguageParseError(Math.Max(1, error.Line), Math.Max(1, error.Column), Math.Max(0, error.Number),
            error.Message.Length > MessageChars ? error.Message[..MessageChars] : error.Message)).ToList();
        return new(listed, errors.Count > limit);
    }
}
