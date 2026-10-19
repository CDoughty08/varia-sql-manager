using System.Globalization;

namespace Varia.Backend;

internal sealed record SqlBatch(string Sql, int StartLine, int RepeatCount);

/// <summary>Recognizes client batch delimiters without interpreting or rewriting T-SQL.</summary>
internal static class SqlScript
{
    public const int MaxBatchExecutions = 1000;
    private enum Quote { None, String, Identifier, Bracket }

    public static List<SqlBatch> Parse(string sql, int sourceStartLine = 1)
    {
        var batches = new List<SqlBatch>();
        var quote = Quote.None;
        var commentDepth = 0;
        var batchOffset = 0;
        var batchLine = 1;
        var hasSql = false;
        var executions = 0;
        var lineNumber = 1;
        for (var offset = 0; offset < sql.Length; lineNumber++)
        {
            var end = offset;
            while (end < sql.Length && sql[end] is not ('\r' or '\n')) end++;
            var visible = new string(' ', end - offset).ToCharArray();
            // A line continuing a quoted token cannot be a standalone GO command.
            if (quote != Quote.None && visible.Length > 0) visible[0] = '\u0001';
            for (var i = 0; i < visible.Length; i++)
            {
                var c = sql[offset + i];
                var next = i + 1 < visible.Length ? sql[offset + i + 1] : '\0';
                if (commentDepth > 0)
                {
                    if (c == '/' && next == '*') { commentDepth++; i++; }
                    else if (c == '*' && next == '/') { commentDepth--; i++; }
                }
                else if (quote != Quote.None)
                {
                    var closing = quote == Quote.String ? '\'' : quote == Quote.Identifier ? '"' : ']';
                    if (c == closing)
                    {
                        if (next == closing) i++;
                        else quote = Quote.None;
                    }
                }
                else if (c == '-' && next == '-') break;
                else if (c == '/' && next == '*') { commentDepth++; i++; }
                else if (c is '\'' or '"' or '[')
                {
                    visible[i] = '\u0001';
                    quote = c == '\'' ? Quote.String : c == '"' ? Quote.Identifier : Quote.Bracket;
                }
                else visible[i] = c;
            }
            var text = new string(visible);
            var trimmed = text.AsSpan().Trim();
            // A line that starts with "::" continues T-SQL (FROM ::fn_helpcollations(), geography ::Point); no SQLCMD command does.
            if (trimmed.StartsWith(":", StringComparison.Ordinal) && !trimmed.StartsWith("::", StringComparison.Ordinal) || trimmed.StartsWith("!!", StringComparison.Ordinal))
                throw Invalid(lineNumber, "SQLCMD directives are not supported. No file includes, variable expansion, or shell commands are performed.");
            var isGo = trimmed.Length >= 2 && trimmed[..2].Equals("GO", StringComparison.OrdinalIgnoreCase)
                && (trimmed.Length == 2 || !IsIdentifierPart(trimmed[2]));
            if (isGo)
            {
                var countText = trimmed[2..].Trim();
                var count = 1;
                if (!countText.IsEmpty && (!countText.ToString().All(c => c is >= '0' and <= '9')
                    || !int.TryParse(countText, NumberStyles.None, CultureInfo.InvariantCulture, out count) || count is < 1 or > MaxBatchExecutions))
                    throw Invalid(lineNumber, $"Use GO or GO followed by a positive integer (maximum {MaxBatchExecutions}). GO; and GO 0 are not supported.");
                var first = 0;
                while (first < text.Length && char.IsWhiteSpace(text[first])) first++;
                var last = text.Length;
                while (last > first && char.IsWhiteSpace(text[last - 1])) last--;
                // Preserve comments before/after the delimiter, including multiline comments.
                if (hasSql) Add(sql[batchOffset..(offset + first)], batchLine, count);
                batchOffset = offset + last;
                batchLine = lineNumber;
                // A GO line with nothing after it ends with its line break, as in SSMS and sqlcmd: the next batch starts on
                // the next line, so a module created from a script does not store the break as a leading blank line.
                if (sql.AsSpan(batchOffset, end - batchOffset).IsWhiteSpace())
                {
                    batchOffset = end < sql.Length && sql[end] == '\r' && end + 1 < sql.Length && sql[end + 1] == '\n' ? end + 2 : Math.Min(end + 1, sql.Length);
                    batchLine = lineNumber + 1;
                }
                hasSql = false;
            }
            else if (!trimmed.IsEmpty) hasSql = true;
            offset = end;
            if (offset < sql.Length && sql[offset] == '\r') offset++;
            if (offset < sql.Length && sql[offset] == '\n') offset++;
        }
        if (quote != Quote.None || commentDepth != 0) throw Invalid(Math.Max(1, lineNumber - 1), "Unterminated quoted text or block comment.");
        if (hasSql) Add(sql[batchOffset..], batchLine, 1);
        return batches;

        void Add(string text, int startLine, int count)
        {
            executions += count;
            if (executions > MaxBatchExecutions) throw Invalid(startLine, $"A script may execute at most {MaxBatchExecutions} batches, including GO repetitions.");
            batches.Add(new(text, startLine, count));
        }

        RequestException Invalid(int line, string message) => new("INVALID_SCRIPT", $"Line {sourceStartLine + line - 1}: {message} The script was not executed.");
    }

    private static bool IsIdentifierPart(char value) => char.IsLetterOrDigit(value) || value is '_' or '@' or '#' or '$';
}
