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
                // A bare column: its statement's tables, the column deciding when there are several or when a derived table,
                // a CTE or a table variable may hold it instead.
                // A column list's (INSERT's, OUTPUT INTO's) column is that table's, or nothing for a variable, temp table or CTE.
                if (scope.InList) Add(scope.ListTable);
                else
                {
                    var sources = scope.Sources;
                    foreach (var source in sources) Add(sources.Count == 1 && !scope.Partial ? source : source with { Column = parts[0] });
                }
            }
            else
            {
                // On the column, its qualifier's table; on a qualifier, that part's object. An alias hides any object of its
                // name, and a derived table's, CTE's or table variable's has no object to go to.
                var qualifier = parts.Take(caret == parts.Count - 1 ? parts.Count - 1 : caret + 1).ToList();
                if (qualifier.Count == 1 && scope.Knows(qualifier[0]!, out var aliased)) Add(aliased);
                else Add(Object(qualifier));
            }
            return candidates.Count == 0 ? null : new(range, candidates);
        }
        // Not a column: a table reference's own name is that object (a CTE's is none), an alias where it is declared is its
        // table, and any other name (EXEC, a type, a FROM name) is the object it names; another scope's alias never hides it.
        if (scope.NoObject) return null;
        if (scope.Declares) Add(scope.Declared);
        else Add(Object(parts));
        // Without a parse, a qualified column (alias.column or table.column) is as likely as an object.
        if (!scope.Parsed && parts.Count >= 2) Add(Object(parts.Take(parts.Count - 1).ToList()));
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

    /// <summary>What the caret's batch says about the name: whether it is a column, what each alias and table name of its
    /// statement stands for (an object, or nothing for a derived table, CTE or table variable), and the tables of the innermost
    /// query around it. Empty when neither the batch nor the caret's statement parses (or either is too deep).</summary>
    private sealed class Scope
    {
        private static Scope None => new();
        // An alias or table name and the object it stands for; null for one with no object (derived table, CTE, variable).
        private readonly Dictionary<string, DefinitionName?> aliases = new(StringComparer.OrdinalIgnoreCase);
        public bool Parsed { get; private init; }
        public bool Column { get; private set; }
        public List<DefinitionName> Sources { get; } = [];
        /// <summary>The level that gave <see cref="Sources"/> also names a table that is no object, which may hold the column.</summary>
        public bool Partial { get; private set; }

        /// <summary>The caret is on a CTE's name, a CTE reference or another name with no object.</summary>
        public bool NoObject { get; private set; }
        /// <summary>The caret is on an alias where its table declares it; <see cref="Declared"/> is that table (null for none).</summary>
        public bool Declares { get; private set; }
        public DefinitionName? Declared { get; private set; }
        /// <summary>The caret's column is in a column list (INSERT's, OUTPUT INTO's) of this table; null when none, or unknown.</summary>
        public DefinitionName? ListTable { get; private set; }
        public bool InList { get; private set; }

        public bool Knows(string name, out DefinitionName? target) => aliases.TryGetValue(name, out target);

        public static Scope Read(string text, IList<TSqlParserToken> tokens, int offset)
        {
            // Only the caret's batch: an unfinished statement in another batch must not hide this one's aliases.
            var from = 0;
            var to = text.Length;
            for (var index = 0; index < tokens.Count; index++)
            {
                var token = tokens[index];
                if (token.TokenType != TSqlTokenType.Go) continue;
                if (token.Offset > offset) { to = token.Offset; break; }
                // GO 2 repeats the batch before it: the count is GO's, not the next batch's.
                var after = token.Offset + token.Text.Length;
                var count = index + 1;
                while (count < tokens.Count && tokens[count].TokenType == TSqlTokenType.WhiteSpace && !tokens[count].Text.Contains('\n')) count++;
                if (count < tokens.Count && tokens[count].TokenType == TSqlTokenType.Integer) after = tokens[count].Offset + tokens[count].Text.Length;
                if (after <= offset) from = after;
            }
            // A batch that does not parse (a half-typed statement after this one, or one too long) may still have a caret
            // statement that does: up to the next semicolon, then from the previous one.
            int? previous = null, next = null;
            foreach (var token in tokens)
            {
                if (token.TokenType != TSqlTokenType.Semicolon || token.Offset < from || token.Offset >= to) continue;
                if (token.Offset + 1 <= offset) previous = token.Offset + 1;
                else { next = token.Offset + 1; break; }
            }
            List<(int From, int To)> spans = [(from, to)];
            if (next is { } end) spans.Add((from, end));
            if (previous is { } start) spans.Add((start, next ?? to));
            foreach (var span in spans.Distinct())
                if (Parse(text[span.From..span.To], offset - span.From) is { } scope) return scope;
            return None;
        }

        private static Scope? Parse(string batch, int offset)
        {
            var parser = new TSql180Parser(initialQuotedIdentifiers: true);
            var batchTokens = parser.GetTokenStream(new StringReader(batch), out var errors);
            if (errors.Count != 0 || !SqlToolsLanguageService.BoundedCompletionSyntax(batchTokens)) return null;
            var fragment = parser.Parse(batchTokens, out errors);
            if (errors.Count != 0) return null;
            var visitor = new CaretVisitor(offset);
            fragment.Accept(visitor);
            var scope = new Scope { Parsed = true, Column = visitor.Column is not null };
            if (visitor.Statement is null) return scope;
            var ctes = new CteCollector();
            visitor.Statement.Accept(ctes);
            // Only UPDATE's and DELETE's target may name another table of the statement (by its alias or exposed name).
            var byName = ByNameTarget(visitor.Statement);
            // Innermost query first, so its own aliases win over an outer query's of the same name; a bare column's tables are
            // those of the innermost level that names any. A level's subqueries are levels of their own, never its tables.
            var levels = visitor.Queries.AsEnumerable().Reverse().Cast<TSqlFragment>().Append(visitor.Statement);
            var sourced = false;
            foreach (var level in levels)
            {
                var tables = new TableCollector(ctes.Names, byName);
                level.Accept(tables);
                var sourcing = !sourced && tables.Refs.Count != 0;
                // UPDATE c ... FROM dbo.T AS c, and UPDATE T ... FROM dbo.T, name their target by another table of the level: a
                // one-part name with no alias that another table declares (as its alias, or as its own unaliased name).
                bool NamesAnother(TableRef table) => table.ByName && table.Target is { Database: null, Schema: null } && table.Alias is null && table.BaseName is { } own
                    && tables.Refs.Any(other => !ReferenceEquals(other, table) && other.Target != table.Target
                        && (string.Equals(other.Alias, own, StringComparison.OrdinalIgnoreCase) || other.Alias is null && string.Equals(other.BaseName, own, StringComparison.OrdinalIgnoreCase)));
                var named = tables.Refs.Where(table => !NamesAnother(table)).ToList();
                // Aliases before base names, so an alias is never taken for a table of its name; an aliased table's own name is
                // hidden, as SQL Server hides it.
                foreach (var table in named) if (table.Alias is { } alias) scope.aliases.TryAdd(alias, table.Target);
                foreach (var table in named)
                {
                    if (table.Alias is null && table.BaseName is { } baseName) scope.aliases.TryAdd(baseName, table.Target);
                    if (sourcing && table.Target is { } name && !scope.Sources.Contains(name)) scope.Sources.Add(name);
                }
                if (!sourcing) continue;
                sourced = true;
                scope.Partial = tables.Refs.Any(table => table.Target is null);
            }
            // OUTPUT's inserted and deleted are the DML target's rows; elsewhere (a trigger's) they are no object to go to.
            // The object a table reference stands for: UPDATE's and DELETE's target through the statement's other tables, any
            // other by its own name; a CTE, variable or temp table is none.
            DefinitionName? Table(TableReference? reference) => reference switch
            {
                NamedTableReference named2 when IsCte(named2.SchemaObject, ctes.Names) => null,
                NamedTableReference named2 when ReferenceEquals(named2, byName) && named2.SchemaObject is { SchemaIdentifier: null, DatabaseIdentifier: null }
                    && scope.aliases.TryGetValue(named2.SchemaObject.BaseIdentifier.Value, out var known) => known,
                NamedTableReference named2 => NameOf(named2.SchemaObject),
                SchemaObjectFunctionTableReference function => NameOf(function.SchemaObject),
                _ => null
            };
            // OUTPUT's inserted and deleted are the DML target's rows; elsewhere (a trigger's) they are no object to go to.
            if (DmlTarget(visitor.Statement) is { } dml)
            {
                var target = Table(dml);
                scope.aliases.TryAdd("inserted", target);
                scope.aliases.TryAdd("deleted", target);
            }
            scope.aliases.TryAdd("inserted", null);
            scope.aliases.TryAdd("deleted", null);
            // The caret's own table reference, alias or column list.
            if (visitor.CteName || visitor.TableName is { } reference2 && IsCte(reference2.SchemaObject, ctes.Names)) scope.NoObject = true;
            else if (visitor.TableName is { } dmlName && ReferenceEquals(dmlName, byName))
            {
                // UPDATE c ... FROM dbo.T AS c: the target's name is the table it names.
                scope.Declares = true;
                scope.Declared = Table(dmlName);
            }
            if (visitor.AliasOf is { } declaring)
            {
                scope.Declares = true;
                scope.Declared = declaring is NamedTableReference { } own2 && IsCte(own2.SchemaObject, ctes.Names) ? null
                    : declaring is NamedTableReference { } plain ? NameOf(plain.SchemaObject) : Table(declaring);
            }
            if (visitor.ListOf is { } list)
            {
                scope.InList = true;
                scope.ListTable = Table(list);
            }
            return scope;
        }
    }

    private static bool IsCte(SchemaObjectName name, IReadOnlySet<string> ctes) =>
        name.SchemaIdentifier is null && name.DatabaseIdentifier is null && name.ServerIdentifier is null && ctes.Contains(name.BaseIdentifier.Value);

    /// <summary>UPDATE's or DELETE's target, which may name another table of its FROM clause; null for any other statement.</summary>
    private static NamedTableReference? ByNameTarget(TSqlStatement statement) => statement switch
    {
        UpdateStatement update => update.UpdateSpecification?.Target as NamedTableReference,
        DeleteStatement delete => delete.DeleteSpecification?.Target as NamedTableReference,
        _ => null
    };

    /// <summary>The table an INSERT, UPDATE, DELETE or MERGE writes, when it is named.</summary>
    private static NamedTableReference? DmlTarget(TSqlStatement statement) => statement switch
    {
        InsertStatement insert => insert.InsertSpecification?.Target as NamedTableReference,
        UpdateStatement update => update.UpdateSpecification?.Target as NamedTableReference,
        DeleteStatement delete => delete.DeleteSpecification?.Target as NamedTableReference,
        MergeStatement merge => merge.MergeSpecification?.Target as NamedTableReference,
        _ => null
    };

    /// <summary>An object by its name in a FROM clause or DML target; null for a linked server's, a temporary table, or a
    /// trigger's inserted and deleted.</summary>
    private static DefinitionName? NameOf(SchemaObjectName name)
    {
        if (name.ServerIdentifier is not null || name.BaseIdentifier?.Value is not { Length: > 0 } baseName || baseName.StartsWith('#')) return null;
        // A trigger's inserted and deleted are its table's rows, not objects of those names.
        if (name.SchemaIdentifier is null && name.DatabaseIdentifier is null && (baseName.Equals("inserted", StringComparison.OrdinalIgnoreCase) || baseName.Equals("deleted", StringComparison.OrdinalIgnoreCase))) return null;
        return new(name.DatabaseIdentifier?.Value is { Length: > 0 } database ? database : null, name.SchemaIdentifier?.Value is { Length: > 0 } schema ? schema : null, baseName);
    }

    private sealed class CaretVisitor(int offset) : TSqlFragmentVisitor
    {
        private readonly List<QuerySpecification> stack = [];
        public ColumnReferenceExpression? Column { get; private set; }
        public TSqlStatement? Statement { get; private set; }
        public List<QuerySpecification> Queries { get; private set; } = [];
        /// <summary>The table reference whose own name the caret is on.</summary>
        public NamedTableReference? TableName { get; private set; }
        /// <summary>The table reference (or MERGE's target) whose alias the caret is on, where the alias is declared.</summary>
        public TableReference? AliasOf { get; private set; }
        /// <summary>The caret is on a CTE's own name, in its WITH clause.</summary>
        public bool CteName { get; private set; }
        /// <summary>The table whose column list (INSERT's, OUTPUT INTO's) holds the caret's column.</summary>
        public TableReference? ListOf { get; private set; }

        private bool Contains(TSqlFragment? node) => node is not null && node.StartOffset >= 0 && node.StartOffset <= offset && offset <= node.StartOffset + node.FragmentLength;

        public override void ExplicitVisit(NamedTableReference node)
        {
            if (Contains(node.SchemaObject)) TableName ??= node;
            base.ExplicitVisit(node);
        }

        public override void Visit(TableReferenceWithAlias node)
        {
            if (Contains(node.Alias)) AliasOf ??= node;
        }

        public override void ExplicitVisit(MergeSpecification node)
        {
            if (Contains(node.TableAlias)) AliasOf ??= node.Target;
            base.ExplicitVisit(node);
        }

        public override void ExplicitVisit(CommonTableExpression node)
        {
            if (Contains(node.ExpressionName)) CteName = true;
            base.ExplicitVisit(node);
        }

        public override void ExplicitVisit(InsertSpecification node)
        {
            if (node.Columns.Any(Contains)) ListOf ??= node.Target;
            base.ExplicitVisit(node);
        }

        public override void ExplicitVisit(OutputIntoClause node)
        {
            if (node.IntoTableColumns.Any(Contains)) ListOf ??= node.IntoTable;
            base.ExplicitVisit(node);
        }

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

    /// <summary>A table a query level names: its alias, its own name when it has one, and the object it is (null when none).</summary>
    private sealed record TableRef(string? Alias, string? BaseName, DefinitionName? Target, bool ByName = false);

    /// <summary>The statement's CTE names, which its FROM clauses use as tables that are no objects.</summary>
    private sealed class CteCollector : TSqlFragmentVisitor
    {
        public HashSet<string> Names { get; } = new(StringComparer.OrdinalIgnoreCase);
        public override void Visit(CommonTableExpression node) => Names.Add(node.ExpressionName.Value);
    }

    /// <summary>The tables of one query level: its FROM clause and DML target, never those of its subqueries, derived tables or
    /// CTE bodies (levels of their own). A table-valued function's alias stands for the function; MERGE keeps its target's alias
    /// apart from the table reference.</summary>
    private sealed class TableCollector(IReadOnlySet<string> ctes, NamedTableReference? byName) : TSqlFragmentVisitor
    {
        public List<TableRef> Refs { get; } = [];

        private void Named(SchemaObjectName name, Identifier? alias) => Refs.Add(new(alias?.Value, name.BaseIdentifier?.Value, IsCte(name, ctes) ? null : NameOf(name)));

        public override void ExplicitVisit(NamedTableReference node) =>
            Refs.Add(new(node.Alias?.Value, node.SchemaObject.BaseIdentifier?.Value, IsCte(node.SchemaObject, ctes) ? null : NameOf(node.SchemaObject), ReferenceEquals(node, byName)));
        // Its parameters may hold subqueries: not this level's tables.
        public override void ExplicitVisit(SchemaObjectFunctionTableReference node) => Named(node.SchemaObject, node.Alias);
        public override void ExplicitVisit(QueryDerivedTable node) => Refs.Add(new(node.Alias?.Value, null, null));
        public override void ExplicitVisit(ScalarSubquery node) { }
        public override void ExplicitVisit(CommonTableExpression node) { }
        public override void ExplicitVisit(MergeSpecification node)
        {
            if (node.Target is NamedTableReference target) Named(target.SchemaObject, node.TableAlias ?? target.Alias);
            else node.Target?.Accept(this);
            node.TableReference?.Accept(this);
        }
        // Every other aliased table (a table variable, VALUES, PIVOT, OPENJSON, a built-in function) is no object; PIVOT's own
        // source is still visited below it.
        public override void Visit(TableReferenceWithAlias node) => Refs.Add(new(node.Alias?.Value, null, null));
    }
}
