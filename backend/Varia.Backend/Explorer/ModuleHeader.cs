namespace Varia.Backend.Explorer;

/// <summary>Reads which parameters of a T-SQL procedure or function declare a default, from the module's CREATE or ALTER
/// header (sys.parameters reports defaults only for CLR modules). Any surprise returns null, and labels then omit the
/// default token.</summary>
internal static class ModuleHeader
{
    public const int MaxDefinition = 65_536;
    public const int MaxParameters = 2100;
    private enum Kind { Word, Variable, Quoted, String, Number, Symbol, End }
    private readonly record struct Token(Kind Kind, string Text);

    public static IReadOnlySet<string>? ParameterDefaults(string? definition)
    {
        if (definition is null) return null;
        try { return Parse(Tokens(definition.Length > MaxDefinition ? definition[..MaxDefinition] : definition)); }
        catch (FormatException) { return null; }
    }

    private static HashSet<string>? Parse(IEnumerator<Token> tokens)
    {
        var current = Next();
        Token Next() => tokens.MoveNext() ? tokens.Current : new Token(Kind.End, "");
        bool Is(string word) => current.Kind == Kind.Word && current.Text.Equals(word, StringComparison.OrdinalIgnoreCase);
        bool IsSymbol(string symbol) => current.Kind == Kind.Symbol && current.Text == symbol;
        void Expect(bool condition) { if (!condition) throw new FormatException(); }

        if (Is("CREATE"))
        {
            current = Next();
            if (Is("OR")) { current = Next(); Expect(Is("ALTER")); current = Next(); }
        }
        else { Expect(Is("ALTER")); current = Next(); }
        Expect(Is("PROC") || Is("PROCEDURE") || Is("FUNCTION"));
        current = Next();
        // A one- to three-part name, then a procedure's optional ;number.
        Expect(current.Kind is Kind.Word or Kind.Quoted);
        current = Next();
        for (var parts = 1; IsSymbol(".") && parts < 3; parts++)
        {
            current = Next();
            Expect(current.Kind is Kind.Word or Kind.Quoted);
            current = Next();
        }
        if (IsSymbol(";")) { current = Next(); Expect(current.Kind == Kind.Number); current = Next(); }
        var parenthesized = IsSymbol("(");
        if (parenthesized) current = Next();
        var defaults = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var count = 0;
        while (current.Kind == Kind.Variable)
        {
            if (++count > MaxParameters) return null;
            var name = current.Text;
            current = Next();
            if (Is("AS")) current = Next();
            // The type: a one- or two-part name with an optional argument list (nvarchar(50), xml(CONTENT dbo.c)).
            Expect(current.Kind is Kind.Word or Kind.Quoted);
            current = Next();
            if (IsSymbol(".")) { current = Next(); Expect(current.Kind is Kind.Word or Kind.Quoted); current = Next(); }
            if (IsSymbol("("))
            {
                for (var depth = 1; depth > 0;)
                {
                    current = Next();
                    Expect(current.Kind != Kind.End);
                    if (IsSymbol("(")) depth++;
                    else if (IsSymbol(")")) depth--;
                }
                current = Next();
            }
            if (Is("VARYING")) current = Next();
            if (Is("NOT")) { current = Next(); Expect(Is("NULL")); current = Next(); }
            else if (Is("NULL")) current = Next();
            if (IsSymbol("="))
            {
                defaults.Add(name);
                current = Next();
                if (IsSymbol("-") || IsSymbol("+") || IsSymbol("$")) current = Next();
                Expect(current.Kind is Kind.String or Kind.Number or Kind.Word);
                current = Next();
            }
            while (Is("OUT") || Is("OUTPUT") || Is("READONLY")) current = Next();
            if (IsSymbol(",")) { current = Next(); Expect(current.Kind == Kind.Variable); }
        }
        if (parenthesized) { Expect(IsSymbol(")")); current = Next(); }
        Expect(Is("AS") || Is("RETURNS") || Is("WITH") || Is("FOR"));
        return defaults;
    }

    /// <summary>The lexer's rules match SqlScript: strings with doubled quotes, [] and "" identifiers, line comments and
    /// nested block comments.</summary>
    private static IEnumerator<Token> Tokens(string text)
    {
        var i = 0;
        while (true)
        {
            while (i < text.Length)
            {
                if (char.IsWhiteSpace(text[i])) i++;
                else if (text[i] == '-' && i + 1 < text.Length && text[i + 1] == '-') { while (i < text.Length && text[i] is not ('\n' or '\r')) i++; }
                else if (text[i] == '/' && i + 1 < text.Length && text[i + 1] == '*')
                {
                    var depth = 0;
                    do
                    {
                        if (i + 1 >= text.Length) throw new FormatException();
                        if (text[i] == '/' && text[i + 1] == '*') { depth++; i += 2; }
                        else if (text[i] == '*' && text[i + 1] == '/') { depth--; i += 2; }
                        else i++;
                    } while (depth > 0);
                }
                else break;
            }
            if (i >= text.Length) { yield return new Token(Kind.End, ""); yield break; }
            var start = i;
            var c = text[i];
            if (c is '\'' || (c is 'N' or 'n') && i + 1 < text.Length && text[i + 1] == '\'')
            {
                i += c == '\'' ? 1 : 2;
                Close('\'');
                yield return new Token(Kind.String, "");
            }
            else if (c is '[' or '"')
            {
                i++;
                Close(c == '[' ? ']' : '"');
                yield return new Token(Kind.Quoted, text[(start + 1)..(i - 1)]);
            }
            else if (char.IsDigit(c) || c == '.' && i + 1 < text.Length && char.IsDigit(text[i + 1]))
            {
                while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] == '.' || text[i] is '+' or '-' && text[i - 1] is 'e' or 'E')) i++;
                yield return new Token(Kind.Number, text[start..i]);
            }
            else if (char.IsLetter(c) || c is '_' or '@' or '#')
            {
                i++;
                while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or '@' or '#' or '$')) i++;
                yield return new Token(c == '@' ? Kind.Variable : Kind.Word, text[start..i]);
            }
            else
            {
                i++;
                yield return new Token(Kind.Symbol, c.ToString());
            }
        }

        void Close(char quote)
        {
            while (true)
            {
                if (i >= text.Length) throw new FormatException();
                if (text[i] == quote)
                {
                    if (i + 1 < text.Length && text[i + 1] == quote) { i += 2; continue; }
                    i++;
                    return;
                }
                i++;
            }
        }
    }
}
