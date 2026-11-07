using System.Text;

namespace Varia.Backend.Plans;

/// <summary>Conservative lexical guard, not a T-SQL rewriter. SHOWPLAN OFF would allow a later batch to execute.
/// Inspect the entire script before connecting; strings and nested comments are data. Unknown SQL stays SQL Server's job.</summary>
internal static class EstimatedPlanScript
{
    private static readonly HashSet<string> CaptureOptions = new(["SHOWPLAN_XML", "SHOWPLAN_ALL", "SHOWPLAN_TEXT", "NOEXEC", "PARSEONLY", "FMTONLY"], StringComparer.OrdinalIgnoreCase);
    internal sealed record Batch(SqlBatch Source, string? Database);
    private sealed record Token(string Value, bool Word, bool Identifier = false);

    public static List<Batch> Parse(string sql, int startLine)
    {
        return SqlScript.Parse(sql, startLine).Select(batch =>
        {
            var tokens = Tokens(batch.Sql);
            foreach (var token in tokens)
                if ((token.Word || token.Identifier) && CaptureOptions.Contains(token.Value))
                    throw Invalid(batch, "Remove SHOWPLAN, NOEXEC, PARSEONLY and FMTONLY options before requesting an estimated plan.");
            bool Is(int index, string text) => index < tokens.Count && tokens[index].Word && tokens[index].Value.Equals(text, StringComparison.OrdinalIgnoreCase);
            var uses = Enumerable.Range(0, tokens.Count).Where(i => Is(i, "USE") && !Is(i + 1, "HINT") && !Is(i + 1, "PLAN")).ToArray();
            string? database = null;
            if (uses.Length > 0)
            {
                if (uses.Length != 1 || uses[0] != 0 || tokens.Count is not (2 or 3) || !(tokens[1].Word || tokens[1].Identifier)
                    || tokens.Count == 3 && tokens[2].Value != ";")
                    throw Invalid(batch, "Put USE in its own GO batch, or select the database in the query toolbar, before requesting an estimated plan.");
                database = tokens[1].Value;
                if (string.IsNullOrWhiteSpace(database) || database.Length > 128) throw Invalid(batch, "The USE database name is invalid.");
            }
            return new Batch(batch, database);
        }).ToList();

        RequestException Invalid(SqlBatch batch, string message) => new("INVALID_SCRIPT", $"Line {startLine + batch.StartLine - 1}: {message} No submitted SQL was executed.");
    }

    private static List<Token> Tokens(string sql)
    {
        var tokens = new List<Token>();
        for (var i = 0; i < sql.Length;)
        {
            var c = sql[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '-' && i + 1 < sql.Length && sql[i + 1] == '-')
            { while (i < sql.Length && sql[i] is not ('\r' or '\n')) i++; continue; }
            if (c == '/' && i + 1 < sql.Length && sql[i + 1] == '*')
            {
                i += 2;
                var depth = 1;
                while (i < sql.Length && depth > 0)
                {
                    if (i + 1 < sql.Length && sql[i] == '/' && sql[i + 1] == '*') { depth++; i += 2; }
                    else if (i + 1 < sql.Length && sql[i] == '*' && sql[i + 1] == '/') { depth--; i += 2; }
                    else i++;
                }
                continue;
            }
            if (c is '\'' or '"' or '[')
            {
                var closing = c == '[' ? ']' : c;
                var value = new StringBuilder();
                i++;
                while (i < sql.Length)
                {
                    var next = sql[i++];
                    if (next == closing)
                    {
                        if (i < sql.Length && sql[i] == closing) i++;
                        else break;
                    }
                    value.Append(next);
                }
                tokens.Add(new(value.ToString(), false, c != '\''));
                continue;
            }
            if (char.IsLetterOrDigit(c) || c is '_' or '@' or '#' or '$')
            {
                var first = i++;
                while (i < sql.Length && (char.IsLetterOrDigit(sql[i]) || sql[i] is '_' or '@' or '#' or '$')) i++;
                tokens.Add(new(sql[first..i], true));
            }
            else { tokens.Add(new(c.ToString(), false)); i++; }
        }
        return tokens;
    }
}
