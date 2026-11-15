using System.Globalization;

namespace Varia.Backend;

/// <param name="Markers">The #Name markers in the batch's comments (ResultNames.cs), offsets relative to the batch text;
/// empty when it has none, so a batch without one is never parsed.</param>
/// <param name="ParenDepth">The deepest nesting of parentheses outside comments, strings and quoted names, which bounds what
/// ScriptDom is given (ResultNames.MaxParenDepth).</param>
internal sealed record SqlBatch(string Sql, int StartLine, int RepeatCount, bool SourceLinesSafe = true, IReadOnlyList<ResultMarker>? Markers = null, int ParenDepth = 0);

/// <summary>Recognizes client batch delimiters without interpreting or rewriting T-SQL.</summary>
internal static class SqlScript
{
    public const int MaxBatchExecutions = 1000;
    private enum Quote { None, String, Identifier, Bracket }

    /// <param name="unbatched">Receives the #Name markers in a run of comments that is no batch (only comments before a GO
    /// or at the end), which name nothing; null when the caller does not report them.</param>
    public static List<SqlBatch> Parse(string sql, int sourceStartLine = 1, List<ResultMarker>? unbatched = null)
    {
        var batches = new List<SqlBatch>();
        var quote = Quote.None;
        var commentDepth = 0;
        var batchOffset = 0;
        var batchLine = 1;
        var hasSql = false;
        var sourceLinesSafe = true;
        var sourceStartSeen = false;
        var executions = 0;
        var lineNumber = 1;
        // Markers since the batch began (the whole script's offsets), and the outermost block comment's start.
        List<ResultMarker>? markers = null;
        var blockStart = 0;
        var blockLine = 0;
        var parens = 0;
        var parenDepth = 0;
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
                    else if (c == '*' && next == '/')
                    {
                        // Only an outermost comment can be a marker: one nested in another is commented out.
                        if (--commentDepth == 0) Marker(blockStart, offset + i + 2, blockLine, sql.AsSpan(blockStart + 2, offset + i - blockStart - 2));
                        i++;
                    }
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
                else if (c == '-' && next == '-')
                {
                    Marker(offset + i, end, lineNumber, sql.AsSpan(offset + i + 2, end - offset - i - 2));
                    break;
                }
                else if (c == '/' && next == '*') { blockStart = offset + i; blockLine = lineNumber; commentDepth++; i++; }
                else if (c is '\'' or '"' or '[')
                {
                    visible[i] = '\u0001';
                    quote = c == '\'' ? Quote.String : c == '"' ? Quote.Identifier : Quote.Bracket;
                }
                else
                {
                    visible[i] = c;
                    if (c == '(') parenDepth = Math.Max(parenDepth, ++parens);
                    else if (c == ')' && parens > 0) parens--;
                }
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
                if (hasSql) Add(batchOffset, offset + first, batchLine, count);
                else Drop(offset + first);
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
                sourceLinesSafe = true;
                sourceStartSeen = false;
                parens = 0;
                parenDepth = 0;
            }
            else if (!trimmed.IsEmpty)
            {
                hasSql = true;
                ObserveSourceScope(text.AsSpan());
            }
            offset = end;
            if (offset < sql.Length && sql[offset] == '\r') offset++;
            if (offset < sql.Length && sql[offset] == '\n') offset++;
        }
        if (quote != Quote.None || commentDepth != 0) throw Invalid(Math.Max(1, lineNumber - 1), "Unterminated quoted text or block comment.");
        if (hasSql) Add(batchOffset, sql.Length, batchLine, 1);
        else Drop(sql.Length);
        return batches;

        void Add(int start, int stop, int startLine, int count)
        {
            executions += count;
            if (executions > MaxBatchExecutions) throw Invalid(startLine, $"A script may execute at most {MaxBatchExecutions} batches, including GO repetitions.");
            batches.Add(new(sql[start..stop], startLine, count, sourceLinesSafe, Take(start, stop, start), parenDepth));
        }

        // A comment that is a marker or a malformed one is kept; any other comment, the usual case, costs one search for '#'.
        void Marker(int start, int stop, int line, ReadOnlySpan<char> body)
        {
            if (body.IndexOf('#') is var hash and >= 0 && ResultNames.TryMarker(body, out var name))
            {
                // The line of the marker itself, which a block comment may put below its opening.
                var at = start + 2 + hash;
                var markerLine = sourceStartLine + line - 1 + LineBreaks(sql.AsSpan(start, at - start));
                (markers ??= []).Add(new(start, stop, markerLine, name));
            }
        }

        // The markers from start to stop, made relative to `origin`; those after stop wait for the next batch, and those
        // before start (on a GO line, between GO and its count) are in no batch and name nothing.
        IReadOnlyList<ResultMarker> Take(int start, int stop, int origin)
        {
            if (markers is null) return [];
            List<ResultMarker> taken = [], left = [];
            foreach (var marker in markers)
                if (marker.Offset >= stop) left.Add(marker);
                else if (marker.Offset >= start) taken.Add(marker with { Offset = marker.Offset - origin, End = marker.End - origin });
                else unbatched?.Add(marker);
            markers = left.Count == 0 ? null : left;
            return taken;
        }

        // A run of comments that is no batch: its markers name nothing.
        void Drop(int stop)
        {
            var dropped = Take(batchOffset, stop, 0);
            unbatched?.AddRange(dropped);
        }

        // SQL Server can report a nested dynamic batch's line with no Procedure name. Those numbers cannot be mapped to
        // the submitted script. Use the already masked lexical text, never words inside comments, strings or quoted names.
        // Unknown first tokens also exclude implicit procedure calls (including quoted names), labels and unfamiliar syntax.
        // This is a conservative navigation hint, not SQL validation; the original text and execution are unchanged.
        void ObserveSourceScope(ReadOnlySpan<char> visible)
        {
            for (var at = 0; at < visible.Length;)
            {
                if (char.IsWhiteSpace(visible[at]) || visible[at] == ';') { at++; continue; }
                if (!IsIdentifierPart(visible[at])) { if (!sourceStartSeen) sourceLinesSafe = false; sourceStartSeen = true; at++; continue; }
                var start = at++;
                while (at < visible.Length && IsIdentifierPart(visible[at])) at++;
                var token = visible[start..at];
                if (!sourceStartSeen) { sourceLinesSafe &= IsStatementStart(token); sourceStartSeen = true; }
                if (token.Equals("EXEC", StringComparison.OrdinalIgnoreCase) || token.Equals("EXECUTE", StringComparison.OrdinalIgnoreCase)
                    || token.Equals("sp_executesql", StringComparison.OrdinalIgnoreCase)) sourceLinesSafe = false;
            }
        }

        RequestException Invalid(int line, string message) => new("INVALID_SCRIPT", $"Line {sourceStartLine + line - 1}: {message} The script was not executed.");
    }

    /// <summary>Line breaks as the scan counts them: CRLF, LF, or a CR alone.</summary>
    private static int LineBreaks(ReadOnlySpan<char> text)
    {
        var count = 0;
        for (var i = 0; i < text.Length; i++)
            if (text[i] == '\n' || text[i] == '\r' && (i + 1 == text.Length || text[i + 1] != '\n')) count++;
        return count;
    }

    private static bool IsIdentifierPart(char value) => char.IsLetterOrDigit(value) || value is '_' or '@' or '#' or '$';
    private static bool IsStatementStart(ReadOnlySpan<char> token) => token.ToString().ToUpperInvariant() is
        "SELECT" or "WITH" or "INSERT" or "UPDATE" or "DELETE" or "MERGE" or "CREATE" or "ALTER" or "DROP" or "TRUNCATE"
        or "DECLARE" or "SET" or "USE" or "BEGIN" or "IF" or "WHILE" or "PRINT" or "RAISERROR" or "RETURN"
        or "WAITFOR" or "COMMIT" or "ROLLBACK" or "SAVE" or "GRANT" or "DENY" or "REVOKE" or "BACKUP" or "RESTORE"
        or "DBCC" or "CHECKPOINT" or "RECONFIGURE" or "SHUTDOWN" or "KILL" or "BULK" or "OPEN" or "CLOSE" or "FETCH" or "DEALLOCATE";
}
