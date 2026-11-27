namespace Varia.Backend.Search;

/// <summary>
/// Whether a T-SQL script a query tab ran may have changed what the Search Objects index lists (docs/object-search.md, Freshness):
/// a word, outside strings, quoted and bracketed identifiers and comments, of a statement that creates, alters, drops or renames an
/// object, grants or takes away what a login may see, runs other text (EXEC, a bare sp_ or xp_ call), or ends a transaction
/// (COMMIT, ROLLBACK: DDL earlier in the transaction becomes visible, or goes). SELECT … INTO a permanent table counts; INSERT INTO,
/// MERGE INTO, OUTPUT INTO and INTO a #temp table or @variable do not. Erring towards yes costs one fingerprint (a tenth of a
/// second) at the next search; a no that is wrong leaves the database until its age makes it due.
/// </summary>
internal static class TsqlChanges
{
    private static readonly HashSet<string> Words = new(StringComparer.OrdinalIgnoreCase)
    {
        "CREATE", "ALTER", "DROP", "EXEC", "EXECUTE", "GRANT", "REVOKE", "DENY", "COMMIT", "ROLLBACK", "ENABLE", "DISABLE", "RENAME", "RESTORE", "DBCC"
    };

    /// <summary>The longest script scanned: a longer one is taken to change objects without being read.</summary>
    public const int MostChars = 1_000_000;

    public static bool MayChangeObjects(string sql)
    {
        if (sql.Length > MostChars) return true;
        string? previous = null;
        var intoPending = false;
        var i = 0;
        var n = sql.Length;
        while (i < n)
        {
            var c = sql[i];
            if (c == '-' && i + 1 < n && sql[i + 1] == '-')
            {
                while (i < n && sql[i] != '\n') i++;
                continue;
            }
            if (c == '/' && i + 1 < n && sql[i + 1] == '*')
            {
                // Block comments nest in T-SQL.
                var depth = 0;
                while (i < n)
                {
                    if (sql[i] == '/' && i + 1 < n && sql[i + 1] == '*') { depth++; i += 2; }
                    else if (sql[i] == '*' && i + 1 < n && sql[i + 1] == '/') { depth--; i += 2; if (depth == 0) break; }
                    else i++;
                }
                continue;
            }
            if (c is '\'' or '"' or '[')
            {
                var close = c == '[' ? ']' : c;
                i++;
                while (i < n)
                {
                    if (sql[i] == close)
                    {
                        // A doubled closing character is the character itself.
                        if (i + 1 < n && sql[i + 1] == close) { i += 2; continue; }
                        break;
                    }
                    i++;
                }
                i++;
                // A quoted name after INTO is a permanent table.
                if (intoPending && c != '\'') return true;
                intoPending = false;
                previous = null;
                continue;
            }
            if (char.IsLetter(c) || c is '_' or '@' or '#')
            {
                var start = i;
                while (i < n && (char.IsLetterOrDigit(sql[i]) || sql[i] is '_' or '@' or '#' or '$')) i++;
                var word = sql[start..i];
                if (intoPending)
                {
                    if (word[0] is not ('#' or '@')) return true;
                    intoPending = false;
                }
                if (Words.Contains(word)) return true;
                if (word.Length > 3 && (word.StartsWith("sp_", StringComparison.OrdinalIgnoreCase) || word.StartsWith("xp_", StringComparison.OrdinalIgnoreCase))) return true;
                if (word.Equals("INTO", StringComparison.OrdinalIgnoreCase)
                    && !(previous is { } before && (before.Equals("INSERT", StringComparison.OrdinalIgnoreCase) || before.Equals("MERGE", StringComparison.OrdinalIgnoreCase)
                        || before.Equals("OUTPUT", StringComparison.OrdinalIgnoreCase))))
                    intoPending = true;
                previous = word;
                continue;
            }
            // Only adjacent words make INSERT INTO: anything else between them ends what came before.
            if (!char.IsWhiteSpace(c)) previous = null;
            i++;
        }
        return false;
    }
}
