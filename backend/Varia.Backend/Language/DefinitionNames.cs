using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace Varia.Backend.Language;

/// <summary>A name to look up: an object (or user-defined type) by its parts, and, for a column with several possible tables,
/// the column the table must have.</summary>
internal sealed record DefinitionName(string? Database, string? Schema, string Name, string? Column = null);
/// <summary>The multi-part name under the caret (its whole span) and the names it may stand for, most likely first.</summary>
internal sealed record DefinitionLookup(LanguageRange Range, IReadOnlyList<DefinitionName> Candidates);

/// <summary>Go to Definition's text side, with no SQL: the identifier under the caret, the multi-part name it belongs to, and,
/// from the caret's batch parsed by ScriptDom, whether it is a column (whose table is the target) and which tables its
/// statement's aliases name. Never executes or logs the text.</summary>
internal static class DefinitionNames
{
    internal const int MaxCandidates = 8;

    internal static DefinitionLookup? Find(string text, LanguagePosition position)
    {
        var offset = SqlToolsLanguageService.CompletionOffset(text, position);
        if (offset < 0) return null;
        var parser = new TSql180Parser(initialQuotedIdentifiers: true);
        var tokens = parser.GetTokenStream(new StringReader(text), out _);
        if (tokens.Count > 1_000_000) return null;
        var at = TokenAt(tokens, offset);
        if (at < 0) return null;
        // The whole dotted name: identifiers joined by dots, an empty part (db..name) included.
        bool Is(int index, TSqlTokenType type) => index >= 0 && index < tokens.Count && tokens[index].TokenType == type;
        bool Name(int index) => index >= 0 && index < tokens.Count && IsName(tokens[index]);
        var first = at;
        while (Is(first - 1, TSqlTokenType.Dot))
        {
            if (Name(first - 2)) first -= 2;
            else if (Is(first - 2, TSqlTokenType.Dot) && Name(first - 3)) first -= 3;
            else break;
        }
        var last = at;
        while (Is(last + 1, TSqlTokenType.Dot))
        {
            if (Name(last + 2)) last += 2;
            else if (Is(last + 2, TSqlTokenType.Dot) && Name(last + 3)) last += 3;
            else break;
        }
        List<string?> parts = [];
        var caret = 0;
        for (var index = first; index <= last; index++)
        {
            var token = tokens[index];
            if (token.TokenType == TSqlTokenType.Dot)
            {
                // Two dots in a row leave an empty part between them.
                if (index + 1 <= last && tokens[index + 1].TokenType == TSqlTokenType.Dot) parts.Add(null);
                continue;
            }
            if (index == at) caret = parts.Count;
            parts.Add(Unquote(token));
        }
        // Temporary objects, table variables and linked servers' four-part names are not this database's to script.
        if (parts.Count is 0 or > 3 || parts[^1] is null || parts.Any(part => part is { Length: 0 or > 128 } || part?.StartsWith('#') == true)) return null;
        var start = tokens[first].Offset;
        var end = tokens[last].Offset + tokens[last].Text.Length;
        var range = new LanguageRange(PositionOf(text, start), PositionOf(text, end));
        var scope = Scope.Read(text, tokens, offset);
        var candidates = new List<DefinitionName>();
        void Add(DefinitionName? name)
        {
            if (name is not null && candidates.Count < MaxCandidates && !candidates.Contains(name)) candidates.Add(name);
        }
        if (scope.Column)
        {
            if (caret == parts.Count - 1 && parts.Count == 1)
            {
                // A bare column: its statement's tables, the column deciding when there are several.
                var sources = scope.Sources;
                foreach (var source in sources) Add(sources.Count == 1 ? source : source with { Column = parts[0] });
            }
            else
            {
                // On the column, its qualifier's table; on a qualifier, that part's object.
                var qualifier = parts.Take(caret == parts.Count - 1 ? parts.Count - 1 : caret + 1).ToList();
                if (qualifier.Count == 1 && scope.Alias(qualifier[0]!) is { } aliased) Add(aliased);
                Add(Object(qualifier));
            }
            return candidates.Count == 0 ? null : new(range, candidates);
        }
        if (parts.Count == 1 && scope.Alias(parts[0]!) is { } alias) Add(alias);
        Add(Object(parts));
        if (!scope.Parsed && parts.Count >= 2)
        {
            // Without a parse, a qualified column (alias.column or table.column) is as likely as an object.
            if (parts.Count == 2 && scope.Alias(parts[0]!) is { } table) Add(table);
            Add(Object(parts.Take(parts.Count - 1).ToList()));
        }
        return candidates.Count == 0 ? null : new(range, candidates);
    }

    /// <summary>An object by one to three parts (database, schema, name); an empty schema (db..name) is the default one.</summary>
    private static DefinitionName? Object(IReadOnlyList<string?> parts) => parts.Count switch
    {
        1 when parts[0] is { } name => new(null, null, name),
        2 when parts[1] is { } name => new(null, parts[0], name),
        3 when parts[2] is { } name && parts[0] is { } database => new(database, parts[1], name),
        _ => null
    };

    // With QUOTED_IDENTIFIER on, ScriptDom still tokenizes "name" as AsciiStringOrQuotedIdentifier.
    private static bool IsName(TSqlParserToken token) => token.TokenType is TSqlTokenType.Identifier or TSqlTokenType.QuotedIdentifier or TSqlTokenType.AsciiStringOrQuotedIdentifier;

    /// <summary>The name token the caret is in, or that ends at the caret.</summary>
    private static int TokenAt(IList<TSqlParserToken> tokens, int offset)
    {
        var after = -1;
        for (var index = 0; index < tokens.Count; index++)
        {
            var token = tokens[index];
            if (token.Offset > offset) break;
            var end = token.Offset + (token.Text?.Length ?? 0);
            if (offset < end) return IsName(token) ? index : after;
            if (offset == end && IsName(token)) after = index;
        }
        return after;
    }

    private static string Unquote(TSqlParserToken token)
    {
        var text = token.Text;
        if (token.TokenType is not (TSqlTokenType.QuotedIdentifier or TSqlTokenType.AsciiStringOrQuotedIdentifier) || text.Length < 2) return text;
        return text[0] switch
        {
            '[' => text[1..^1].Replace("]]", "]", StringComparison.Ordinal),
            '"' => text[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal),
            _ => text
        };
    }

    internal static LanguagePosition PositionOf(string text, int offset)
    {
        var line = 0;
        var start = 0;
        for (var at = 0; at < offset && at < text.Length; at++)
        {
            // CRLF ends its line at the LF; a lone CR or LF ends one too, as PositionInText counts them.
            if (text[at] == '\n' || text[at] == '\r' && (at + 1 >= text.Length || text[at + 1] != '\n'))
            {
                start = at + 1;
                line++;
            }
        }
        return new(line, offset - start);
    }

    /// <summary>What the caret's batch says about the name: whether it is a column, the tables its statement names (by alias and
    /// by base name), and those of the innermost query around it. Empty when the batch does not parse (or is too deep).</summary>
    private sealed class Scope
    {
        private static Scope None => new();
        private readonly Dictionary<string, DefinitionName> aliases = new(StringComparer.OrdinalIgnoreCase);
        public bool Parsed { get; private init; }
        public bool Column { get; private set; }
        public List<DefinitionName> Sources { get; } = [];

        public DefinitionName? Alias(string name) => aliases.GetValueOrDefault(name);

        public static Scope Read(string text, IList<TSqlParserToken> tokens, int offset)
        {
            // Only the caret's batch: an unfinished statement in another batch must not hide this one's aliases.
            var from = 0;
            var to = text.Length;
            foreach (var token in tokens)
            {
                if (token.TokenType != TSqlTokenType.Go) continue;
                if (token.Offset + token.Text.Length <= offset) from = token.Offset + token.Text.Length;
                else if (token.Offset > offset) { to = token.Offset; break; }
            }
            var batch = text[from..to];
            var parser = new TSql180Parser(initialQuotedIdentifiers: true);
            var batchTokens = parser.GetTokenStream(new StringReader(batch), out var errors);
            if (errors.Count != 0 || !SqlToolsLanguageService.BoundedCompletionSyntax(batchTokens)) return None;
            var fragment = parser.Parse(batchTokens, out errors);
            if (errors.Count != 0) return None;
            var visitor = new CaretVisitor(offset - from);
            fragment.Accept(visitor);
            var scope = new Scope { Parsed = true, Column = visitor.Column is not null };
            if (visitor.Statement is null) return scope;
            // Innermost query first, so its own aliases win over an outer query's of the same name; a bare column's tables are
            // those of the innermost level that names any.
            var levels = visitor.Queries.AsEnumerable().Reverse().Cast<TSqlFragment>().Append(visitor.Statement);
            foreach (var level in levels)
            {
                var tables = new TableCollector();
                level.Accept(tables);
                var sourcing = scope.Sources.Count == 0;
                var named = tables.Tables.Select(table => (Table: table, Name: Name(table.SchemaObject))).Where(pair => pair.Name is not null).ToList();
                // Aliases before base names: UPDATE c ... FROM dbo.T AS c names its target by the alias, not a table called c.
                foreach (var (table, name) in named) if (table.Alias is { } alias) scope.aliases.TryAdd(alias.Value, name!);
                foreach (var (table, name) in named)
                {
                    scope.aliases.TryAdd(table.SchemaObject.BaseIdentifier.Value, name!);
                    var aliasOnly = name!.Database is null && name.Schema is null && table.Alias is null && scope.aliases.TryGetValue(name.Name, out var target) && target != name;
                    if (sourcing && !aliasOnly && !scope.Sources.Contains(name)) scope.Sources.Add(name);
                }
            }
            return scope;
        }

        private static DefinitionName? Name(SchemaObjectName name)
        {
            // A linked server's table, or a temporary one, is not this server's to script.
            if (name.ServerIdentifier is not null || name.BaseIdentifier?.Value is not { Length: > 0 } baseName || baseName.StartsWith('#')) return null;
            return new(name.DatabaseIdentifier?.Value is { Length: > 0 } database ? database : null, name.SchemaIdentifier?.Value is { Length: > 0 } schema ? schema : null, baseName);
        }
    }

    private sealed class CaretVisitor(int offset) : TSqlFragmentVisitor
    {
        private readonly List<QuerySpecification> stack = [];
        public ColumnReferenceExpression? Column { get; private set; }
        public TSqlStatement? Statement { get; private set; }
        public List<QuerySpecification> Queries { get; private set; } = [];

        private bool Contains(TSqlFragment node) => node.StartOffset <= offset && offset <= node.StartOffset + node.FragmentLength;

        public override void Visit(TSqlStatement node)
        {
            // Pre-order: the last statement around the caret is the innermost (a procedure body's SELECT, not the CREATE).
            if (Contains(node)) Statement = node;
        }

        public override void ExplicitVisit(QuerySpecification node)
        {
            stack.Add(node);
            base.ExplicitVisit(node);
            stack.RemoveAt(stack.Count - 1);
        }

        public override void ExplicitVisit(ColumnReferenceExpression node)
        {
            if (Column is null && node.MultiPartIdentifier is not null && Contains(node))
            {
                Column = node;
                Queries = [.. stack];
            }
            base.ExplicitVisit(node);
        }
    }

    private sealed class TableCollector : TSqlFragmentVisitor
    {
        public List<NamedTableReference> Tables { get; } = [];
        public override void Visit(NamedTableReference node) => Tables.Add(node);
    }
}
