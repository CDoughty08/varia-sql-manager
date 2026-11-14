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
        // The whole dotted name: identifiers joined by dots, an empty part (db..name) included, with white space and comments
        // around the dots as SQL Server allows them (dbo . /* x */ T).
        bool Trivia(int index) => index >= 0 && index < tokens.Count && tokens[index].TokenType is TSqlTokenType.WhiteSpace or TSqlTokenType.MultilineComment or TSqlTokenType.SingleLineComment;
        int Back(int index) { do index--; while (Trivia(index)); return index; }
        int Ahead(int index) { do index++; while (Trivia(index)); return index; }
        bool Is(int index, TSqlTokenType type) => index >= 0 && index < tokens.Count && tokens[index].TokenType == type;
        bool Name(int index) => index >= 0 && index < tokens.Count && IsName(tokens[index]);
        List<int?> before = [], after = [];
        int first = at, last = at;
        for (var current = at; ;)
        {
            var dot = Back(current);
            if (!Is(dot, TSqlTokenType.Dot)) break;
            var previous = Back(dot);
            if (Name(previous)) before.Insert(0, previous);
            else if (Is(previous, TSqlTokenType.Dot) && Name(Back(previous))) { previous = Back(previous); before.InsertRange(0, [previous, null]); }
            else break;
            current = first = previous;
            if (before.Count > 8) return null;
        }
        for (var current = at; ;)
        {
            var dot = Ahead(current);
            if (!Is(dot, TSqlTokenType.Dot)) break;
            var next = Ahead(dot);
            if (Name(next)) after.Add(next);
            else if (Is(next, TSqlTokenType.Dot) && Name(Ahead(next))) { next = Ahead(next); after.AddRange([null, next]); }
            else break;
            current = last = next;
            if (after.Count > 8) return null;
        }
        List<string?> parts = [.. before.Append(at).Concat(after).Select(index => index is { } token ? Unquote(tokens[token]) : null)];
        var caret = before.Count;
        // Temporary objects, table variables and linked servers' four-part names are not this database's to script; a column's
        // four-part name (database.schema.table.column) is checked once the parse says it is one.
        if (parts.Count is 0 or > 4 || parts[^1] is null || parts.Any(part => part is { Length: 0 or > 128 } || part?.StartsWith('#') == true)) return null;
        var start = tokens[first].Offset;
        var end = tokens[last].Offset + tokens[last].Text.Length;
        var range = new LanguageRange(PositionOf(text, start), PositionOf(text, end));
        // A name followed by ( is called: a function, or a method of a column (t.Doc.value(...)).
        var call = Is(Ahead(last), TSqlTokenType.LeftParenthesis);
        // USE earlier in the script changes the database a name without one resolves in, as it does when the script runs.
        string? use = null;
        for (var index = 0; index < first; index++)
            if (tokens[index].TokenType == TSqlTokenType.Use && Ahead(index) is var database && Name(database) && Unquote(tokens[database]) is { Length: > 0 and <= 128 } named) use = named;
        var scope = Scope.Read(text, tokens, offset);
        if (parts.Count == 4 && (!scope.Column || call)) return null;
        var candidates = new List<DefinitionName>();
        void Add(DefinitionName? name)
        {
            if (name is not null && use is not null && name.Database is null) name = name with { Database = use };
            if (name is not null && candidates.Count < MaxCandidates && !candidates.Contains(name)) candidates.Add(name);
        }
        DefinitionLookup? Done() => candidates.Count == 0 ? null : new(range, candidates);
        // A column list's (INSERT's, OUTPUT INTO's, an index's, a foreign key's referenced) column is that table's, or nothing for
        // a variable, temp table or CTE.
        if (scope.InList)
        {
            Add(scope.ListTable);
            return Done();
        }
        if (scope.NoObject) return null;
        if (call && scope.Parsed && parts.Count >= 2)
        {
            // A method of a column when the name starts with an alias or table of the query (t.Doc.value()); otherwise a schema's
            // (or database's) function, or else a method of a bare column (Doc.value()).
            var target = parts.Take(parts.Count - 1).ToList();
            if (target.Count >= 2 && target[0] is { } head && scope.Knows(head, out var table)) Add(table);
            else
            {
                Add(Object(parts));
                if (target is [{ } column]) foreach (var source in scope.Sources.Concat(scope.OuterSources)) Add(source with { Column = column });
            }
            return Done();
        }
        if (scope.Column)
        {
            if (parts.Count == 1)
            {
                // A bare column: its query's tables, the column deciding when there are several, when a derived table, a CTE or
                // a table variable may hold it instead, or when an outer query's tables (offered after) may.
                var sources = scope.Sources;
                var outer = scope.OuterSources;
                var filter = sources.Count != 1 || scope.Partial || outer.Count != 0;
                foreach (var source in sources) Add(filter ? source with { Column = parts[0] } : source);
                foreach (var source in outer) Add(source with { Column = parts[0] });
            }
            else
            {
                // The column's qualifier, wherever the caret is in it (dbo.Orders.Total on dbo is dbo.Orders). An alias hides any
                // object of its name, and a derived table's, CTE's or table variable's has no object to go to.
                var qualifier = parts.Take(parts.Count - 1).ToList();
                if (qualifier.Count == 1 && scope.Knows(qualifier[0]!, out var aliased)) Add(aliased);
                else Add(Object(qualifier));
            }
            return Done();
        }
        // Not a column: a table reference's own name is that object, an alias where it is declared is its table, and any other
        // name (EXEC, a type, a FROM name) is the object it names; another scope's alias never hides it.
        if (scope.Declares) Add(scope.Declared);
        else Add(Object(parts));
        // Without a parse, a qualified column (alias.column or table.column) is as likely as an object.
        if (!scope.Parsed && parts.Count >= 2) Add(Object(parts.Take(parts.Count - 1).ToList()));
        return Done();
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
        /// <summary>The tables of the queries around the one that gave <see cref="Sources"/>, which a correlated column may be of.</summary>
        public List<DefinitionName> OuterSources { get; } = [];
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
            if (Parse(text[from..to], offset - from) is { } whole) return whole;
            // A batch that does not parse (a half-typed statement before or after this one, or one too long) may still hold a
            // caret statement that does. Statements start after a semicolon or at a statement keyword outside parentheses; the
            // widest span of up to four statements around the caret that parses wins (keywords like SET or WITH also occur
            // inside a statement, so a wider span keeps them together).
            List<int> bounds = [from];
            var depth = 0;
            foreach (var token in tokens)
            {
                if (token.Offset < from) continue;
                if (token.Offset >= to) break;
                if (token.TokenType == TSqlTokenType.LeftParenthesis) depth++;
                else if (token.TokenType == TSqlTokenType.RightParenthesis) depth = Math.Max(0, depth - 1);
                else if (token.TokenType == TSqlTokenType.Semicolon) bounds.Add(token.Offset + 1);
                else if (depth == 0 && token.Offset > from && StatementStarts.Contains(token.TokenType)) bounds.Add(token.Offset);
            }
            bounds.Add(to);
            bounds = [.. bounds.Distinct().Order()];
            var at = bounds.FindLastIndex(bound => bound <= offset);
            List<(int From, int To)> spans = [];
            for (var left = Math.Max(0, at - 3); left <= at; left++)
                for (var right = at + 1; right < Math.Min(bounds.Count, at + 5); right++)
                    if ((bounds[left], bounds[right]) != (from, to)) spans.Add((bounds[left], bounds[right]));
            foreach (var span in spans.OrderByDescending(span => span.To - span.From))
                if (Parse(text[span.From..span.To], offset - span.From) is { } scope) return scope;
            return None;
        }

        private static readonly HashSet<TSqlTokenType> StatementStarts =
        [
            TSqlTokenType.Select, TSqlTokenType.Insert, TSqlTokenType.Update, TSqlTokenType.Delete, TSqlTokenType.Merge, TSqlTokenType.With,
            TSqlTokenType.Declare, TSqlTokenType.Set, TSqlTokenType.Exec, TSqlTokenType.Execute, TSqlTokenType.If, TSqlTokenType.While,
            TSqlTokenType.Begin, TSqlTokenType.Create, TSqlTokenType.Alter, TSqlTokenType.Drop, TSqlTokenType.Truncate, TSqlTokenType.Use,
            TSqlTokenType.Print, TSqlTokenType.Return
        ];

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
            var levels = visitor.Queries.Select((query, index) => ((TSqlFragment)query, visitor.Closed[index])).Reverse().Append((visitor.Statement, false));
            bool sourced = false, partial = false, visible = true;
            foreach (var (level, closedLevel) in levels)
            {
                var tables = new TableCollector(ctes.Names, byName);
                level.Accept(tables);
                var sourcing = !sourced && tables.Refs.Any(table => table.Target is not null);
                partial |= !sourced && tables.Refs.Any(table => table.Target is null);
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
                    if (table.Target is not { } name || scope.Sources.Contains(name)) continue;
                    if (sourcing) scope.Sources.Add(name);
                    else if (sourced && visible && !scope.OuterSources.Contains(name)) scope.OuterSources.Add(name);
                }
                // Past a derived table's or CTE's own query, the queries around it are out of reach of its columns.
                if (sourced && closedLevel || sourcing && closedLevel) visible = false;
                if (!sourcing) continue;
                sourced = true;
                scope.Partial = partial;
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
            if (visitor.CteName || visitor.ColumnAlias || visitor.TableName is { } reference2 && (IsCte(reference2.SchemaObject, ctes.Names) || NameOf(reference2.SchemaObject) is null))
                scope.NoObject = true;
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
            else if (visitor.ListName is { } listName)
            {
                scope.InList = true;
                scope.ListTable = NameOf(listName);
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
        // Parallel to the stack: whether that query is closed to the queries around it (a derived table's or a CTE's, which
        // cannot see outer columns; a subquery in an expression or an APPLY can).
        private readonly List<bool> closed = [];
        private bool closing;
        private bool applying;
        /// <summary>Parallel to <see cref="Queries"/>: whether each is closed to the queries around it.</summary>
        public List<bool> Closed { get; private set; } = [];
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
        /// <summary>The table named in an index's or a foreign key's column list that holds the caret.</summary>
        public SchemaObjectName? ListName { get; private set; }
        /// <summary>The caret is on a select list's column alias (AS name), which has no object.</summary>
        public bool ColumnAlias { get; private set; }

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
            var saved = closing;
            closing = true;
            base.ExplicitVisit(node);
            closing = saved;
        }

        public override void ExplicitVisit(InsertSpecification node)
        {
            if (node.Columns.Any(Contains)) ListOf ??= node.Target;
            base.ExplicitVisit(node);
        }

        public override void ExplicitVisit(SelectScalarExpression node)
        {
            if (Contains(node.ColumnName)) ColumnAlias = true;
            base.ExplicitVisit(node);
        }

        public override void ExplicitVisit(CreateIndexStatement node)
        {
            if (node.Columns.Any(column => Contains(column)) || node.IncludeColumns.Any(Contains)) ListName ??= node.OnName;
            base.ExplicitVisit(node);
        }

        public override void ExplicitVisit(ForeignKeyConstraintDefinition node)
        {
            if (node.ReferencedTableColumns.Any(Contains)) ListName ??= node.ReferenceTableName;
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
            closed.Add(closing);
            closing = false;
            // The queries around the caret, innermost last, whatever is under it (a column, a call, a table).
            if (Column is null && Contains(node)) { Queries = [.. stack]; Closed = [.. closed]; }
            base.ExplicitVisit(node);
            stack.RemoveAt(stack.Count - 1);
            closed.RemoveAt(closed.Count - 1);
        }

        public override void ExplicitVisit(QueryDerivedTable node)
        {
            var (savedClosing, savedApplying) = (closing, applying);
            (closing, applying) = (!applying, false);
            base.ExplicitVisit(node);
            (closing, applying) = (savedClosing, savedApplying);
        }

        public override void ExplicitVisit(UnqualifiedJoin node)
        {
            node.FirstTableReference?.Accept(this);
            var saved = applying;
            applying = node.UnqualifiedJoinType is UnqualifiedJoinType.CrossApply or UnqualifiedJoinType.OuterApply;
            node.SecondTableReference?.Accept(this);
            applying = saved;
        }

        public override void ExplicitVisit(ColumnReferenceExpression node)
        {
            if (Column is null && node.MultiPartIdentifier is not null && Contains(node))
            {
                Column = node;
                Queries = [.. stack];
                Closed = [.. closed];
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
