using System.Text.Json;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace Varia.Backend.Language;

internal sealed partial class SqlToolsLanguageService
{
    internal const int MaxCompletionQualifiers = 16;
    private const string CompletionMarker = "__varia_completion_cursor_8c1f6e__";
    private static readonly JsonSerializerOptions CompletionJson = new(JsonSerializerDefaults.Web);

    internal sealed record CompletionScope(LanguageRange Range, int Start, int End, IReadOnlyList<string> Qualifiers, IReadOnlySet<string> OutputAliases);

    private static async Task<JsonElement> ScopedCompletionAsync(ILspClient current, Document document, LanguageRequest request,
        object position, CancellationToken token)
    {
        var original = await CompletionAsync(current, document, request, position, token);
        var array = CompletionArray(original);
        if (array.ValueKind != JsonValueKind.Array || !array.EnumerateArray().Any(IsColumn)) return original;
        var scope = ResolveCompletionScope(array, request.Text, request.Position);
        if (scope is null || scope.Qualifiers.Count == 0) return original;

        // STS merges equal-named declarations and supplies no provenance. Ask its binder about each correlation
        // name in the same SQL scope instead of guessing a column's table from its name or display detail.
        var incomplete = scope.Qualifiers.Count > MaxCompletionQualifiers || Property(original, "isIncomplete").ValueKind == JsonValueKind.True;
        var completeScope = scope.Qualifiers.Count <= MaxCompletionQualifiers;
        var resultColumns = array.EnumerateArray().Where(IsColumn).Select(item => String(item, "label")).OfType<string>()
            .Select(UnquoteCompletion).ToHashSet(StringComparer.Ordinal);
        var prefix = CompletionPrefix(array, request.Text, request.Position);
        PriorityQueue<JsonElement, (int Rank, int Kind, int Order)> candidates = new();
        var order = 0;
        void Include(JsonElement item)
        {
            candidates.Enqueue(item, (prefix.Length == 0 ? 0 : -CompletionRank(item, prefix), IsColumn(item) ? 0 : -1, -order++));
            if (candidates.Count <= MaxCompletionItems) return;
            candidates.Dequeue();
            incomplete = true;
        }
        var remoteText = request.Text;
        var changed = false;
        var uncertain = false;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            foreach (var qualifier in scope.Qualifiers.Take(MaxCompletionQualifiers))
            {
                var insertion = qualifier + ".";
                var probeText = request.Text[..scope.Start] + insertion + request.Text[scope.End..];
                try
                {
                    await ReplaceCompletionBufferAsync(current, document, remoteText, probeText, budget.Token);
                }
                catch { uncertain = true; throw; }
                changed = true;
                remoteText = probeText;
                var probePosition = EndPosition(probeText[..(scope.Start + insertion.Length)]);
                var probe = request with { Text = probeText, Position = probePosition };
                var result = await CompletionAsync(current, document, probe,
                    new { textDocument = new { uri = document.Uri }, position = probePosition }, budget.Token);
                var columns = CompletionArray(result);
                if (columns.ValueKind != JsonValueKind.Array || !columns.EnumerateArray().Any(IsColumn))
                {
                    incomplete = true;
                    completeScope = false;
                    continue;
                }
                foreach (var column in columns.EnumerateArray().Where(IsColumn))
                {
                    if (String(column, "label") is { } name) resultColumns.Remove(UnquoteCompletion(name));
                    if (QualifyCompletion(column, qualifier, scope.Range) is { } qualified) Include(qualified);
                }
            }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && !uncertain) { incomplete = true; completeScope = false; }
        catch (RequestException error) when (error.Code == "TIMEOUT") { incomplete = true; completeScope = false; }
        finally
        {
            // The transport may have stopped during a partially written change. Only a new client can reconcile
            // that state. Otherwise restore under an independent cleanup budget, including caller cancellation.
            if (uncertain) current.Dispose();
            else if (changed)
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                try { await ReplaceCompletionBufferAsync(current, document, remoteText, request.Text, cleanup.Token); }
                catch { current.Dispose(); throw; }
            }
            if (changed) document.ParsedVersion = 0;
        }
        token.ThrowIfCancellationRequested();
        // Never mix ambiguous bare fields back into a scope whose authoritative expansion was bounded or busy.
        foreach (var item in array.EnumerateArray())
            // Result aliases, such as a computed SELECT expression in ORDER BY, have no table qualifier.
            // Retain them only after every source was bound, so a busy/truncated expansion cannot restore
            // ambiguous table fields under bare names.
            if (!IsColumn(item) || completeScope && String(item, "label") is { } name
                && (resultColumns.Contains(UnquoteCompletion(name)) || scope.OutputAliases.Contains(UnquoteCompletion(name)))) Include(item);
        var items = candidates.UnorderedItems.OrderByDescending(item => item.Priority).Select(item => item.Element);
        return JsonSerializer.SerializeToElement(new { items, isIncomplete = incomplete }, CompletionJson);
    }

    private static Task ReplaceCompletionBufferAsync(ILspClient current, Document document, string previous, string text, CancellationToken token) =>
        current.NotifyAsync("textDocument/didChange", new
        {
            textDocument = new { uri = document.Uri, version = ++document.RemoteVersion },
            contentChanges = new[] { new { range = new LanguageRange(new(0, 0), EndPosition(previous)), rangeLength = previous.Length, text } }
        }, token);

    private static JsonElement CompletionArray(JsonElement value) => value.ValueKind == JsonValueKind.Array ? value : Property(value, "items");
    private static bool IsColumn(JsonElement item) => Number(item, "kind") == 5;

    internal static JsonElement? QualifyCompletion(JsonElement column, string qualifier, LanguageRange range)
    {
        var label = String(column, "label");
        var insert = String(Property(column, "textEdit"), "newText") ?? String(column, "insertText") ?? label;
        if (string.IsNullOrEmpty(label) || label.Length > 1024 || string.IsNullOrEmpty(insert) || insert.Length > 16_384
            || Number(column, "insertTextFormat") == 2) return null;
        return JsonSerializer.SerializeToElement(new
        {
            label = qualifier + "." + label, kind = 5, detail = Bounded(String(column, "detail"), 4096),
            documentation = EmptyToNull(ReadContents(Property(column, "documentation"), 16_384)),
            insertText = qualifier + "." + insert, insertTextFormat = 1,
            textEdit = new { range, newText = qualifier + "." + insert },
            filterText = UnquoteCompletion(label), sortText = String(column, "sortText")
        }, CompletionJson);
    }

    internal static CompletionScope? ResolveCompletionScope(JsonElement array, string text, LanguagePosition position)
    {
        var cursor = CompletionOffset(text, position);
        if (cursor < 0) return null;
        LanguageRange? replacement = null;
        foreach (var item in array.EnumerateArray())
        {
            var edit = Property(item, "textEdit");
            var range = ReadRange(Property(edit, "range")) ?? ReadRange(Property(edit, "replace"));
            if (range is null) continue;
            var start = CompletionOffset(text, range.Start);
            var end = CompletionOffset(text, range.End);
            if (start < 0 || end < start || cursor < start || cursor > end) continue;
            replacement = range;
            break;
        }
        // Qualification must use the provider's identifier replacement span. A guessed word boundary could
        // replace only half a quoted identifier or duplicate a qualifier Monaco already retained.
        if (replacement is null) return null;
        var from = CompletionOffset(text, replacement.Start);
        var to = CompletionOffset(text, replacement.End);
        var parsedText = text[..from] + "[" + CompletionMarker + "]" + text[to..];
        var parser = new TSql180Parser(initialQuotedIdentifiers: true);
        var tokens = parser.GetTokenStream(new StringReader(parsedText), out var errors);
        if (errors.Count != 0 || !BoundedCompletionSyntax(tokens)) return null;
        var fragment = parser.Parse(tokens, out errors);
        if (errors.Count != 0) return null;
        var visitor = new CompletionScopeVisitor(parsedText, from);
        fragment.Accept(visitor);
        return visitor.Qualifiers is { Count: > 0 } qualifiers ? new(replacement, from, to, qualifiers, visitor.OutputAliases) : null;
    }

    private static bool BoundedCompletionSyntax(IList<TSqlParserToken> tokens)
    {
        // ScriptDom's grammar is recursive. Tokenize before parsing so hostile nesting cannot overflow the
        // backend stack; complex buffers still receive the out-of-process provider's ordinary suggestions.
        if (tokens.Count > 16_384) return false;
        var parentheses = 0;
        var recursiveKeywords = 0;
        var unary = 0;
        var operators = 0;
        foreach (var token in tokens)
        {
            if (token.TokenType is TSqlTokenType.WhiteSpace or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment) continue;
            if (token.TokenType == TSqlTokenType.LeftParenthesis && ++parentheses > 64) return false;
            if (token.TokenType == TSqlTokenType.RightParenthesis && --parentheses < 0) return false;
            if (token.TokenType is TSqlTokenType.Select or TSqlTokenType.Begin or TSqlTokenType.Case or TSqlTokenType.If or TSqlTokenType.While or TSqlTokenType.Join
                || string.Equals(token.Text, "APPLY", StringComparison.OrdinalIgnoreCase))
                if (++recursiveKeywords > 64) return false;
            unary = token.Text is "+" or "-" or "~" || string.Equals(token.Text, "NOT", StringComparison.OrdinalIgnoreCase) ? unary + 1 : 0;
            if (unary > 64) return false;
            if (token.Text is "+" or "-" or "~" or "*" or "/" or "%" or "^" or "|" or "&" or "=" or "<" or ">" or "<>" or "<=" or ">=" or "!=" or "!<" or "!>"
                || string.Equals(token.Text, "AND", StringComparison.OrdinalIgnoreCase) || string.Equals(token.Text, "OR", StringComparison.OrdinalIgnoreCase))
                if (++operators > 256) return false;
        }
        return true;
    }

    private static int CompletionOffset(string text, LanguagePosition position)
    {
        if (!PositionInText(text, position)) return -1;
        var line = 0;
        var start = 0;
        for (var at = 0; at < text.Length && line < position.Line; at++)
        {
            if (text[at] is not ('\r' or '\n')) continue;
            if (text[at] == '\r' && at + 1 < text.Length && text[at + 1] == '\n') at++;
            start = at + 1;
            line++;
        }
        return start + position.Character;
    }

    private sealed class CompletionScopeVisitor(string text, int markerOffset) : TSqlFragmentVisitor
    {
        private sealed record SourceScope(QuerySpecification? Query, IReadOnlyList<Identifier>? LateralSources = null);
        private readonly List<SourceScope> scopes = [];
        private readonly List<QuerySpecification?> orderByScopes = [];
        private readonly Dictionary<QueryDerivedTable, IReadOnlyList<Identifier>> lateralTables = [];
        public IReadOnlyList<string>? Qualifiers { get; private set; }
        public IReadOnlySet<string> OutputAliases { get; private set; } = new HashSet<string>(StringComparer.Ordinal);

        public override void ExplicitVisit(QuerySpecification node)
        {
            scopes.Add(new(node));
            base.ExplicitVisit(node);
            scopes.RemoveAt(scopes.Count - 1);
        }

        public override void ExplicitVisit(UnqualifiedJoin node)
        {
            var lateral = node.UnqualifiedJoinType is UnqualifiedJoinType.CrossApply or UnqualifiedJoinType.OuterApply
                ? node.SecondTableReference as QueryDerivedTable : null;
            if (lateral is not null) lateralTables.Add(lateral, CorrelationNames(node.FirstTableReference).ToList());
            base.ExplicitVisit(node);
            if (lateral is not null) lateralTables.Remove(lateral);
        }

        public override void ExplicitVisit(QueryDerivedTable node)
        {
            // Derived tables skip their immediate SELECT's sources while retaining higher outer correlations.
            // APPLY additionally sees its left operand, but neither its own output alias nor later joins.
            scopes.Add(new(null, lateralTables.GetValueOrDefault(node) ?? []));
            base.ExplicitVisit(node);
            scopes.RemoveAt(scopes.Count - 1);
        }

        public override void ExplicitVisit(OrderByClause node)
        {
            orderByScopes.Add(scopes.LastOrDefault()?.Query);
            base.ExplicitVisit(node);
            orderByScopes.RemoveAt(orderByScopes.Count - 1);
        }

        public override void ExplicitVisit(ColumnReferenceExpression node)
        {
            if (node.StartOffset != markerOffset || node.MultiPartIdentifier?.Identifiers is not { Count: 1 } identifiers
                || identifiers[0].Value != CompletionMarker) return;
            List<string> found = [];
            HashSet<string> hidden = new(StringComparer.Ordinal);
            var skipEnclosingQuery = false;
            foreach (var scope in scopes.AsEnumerable().Reverse())
            {
                IReadOnlyList<Identifier> names;
                if (scope.Query is null)
                {
                    names = scope.LateralSources!;
                    skipEnclosingQuery = true;
                }
                else
                {
                    if (skipEnclosingQuery) { skipEnclosingQuery = false; continue; }
                    names = scope.Query.FromClause?.TableReferences.SelectMany(CorrelationNames).ToList() ?? [];
                }
                foreach (var group in names.GroupBy(identifier => identifier.Value, StringComparer.Ordinal))
                {
                    if (!hidden.Add(group.Key) || group.Count() != 1) continue;
                    var name = group.Single();
                    found.Add(text.Substring(name.StartOffset, name.FragmentLength));
                }
            }
            Qualifiers = found;
            var query = scopes.LastOrDefault()?.Query;
            if (query is not null && orderByScopes.Contains(query))
                OutputAliases = query.SelectElements.OfType<SelectScalarExpression>().Select(element => element.ColumnName?.Value)
                    .OfType<string>().GroupBy(name => name, StringComparer.Ordinal).Where(group => group.Count() == 1)
                    .Select(group => group.Key).ToHashSet(StringComparer.Ordinal);
        }

        private static IEnumerable<Identifier> CorrelationNames(TableReference table)
        {
            switch (table)
            {
                case JoinTableReference join:
                    foreach (var name in CorrelationNames(join.FirstTableReference).Concat(CorrelationNames(join.SecondTableReference))) yield return name;
                    break;
                case JoinParenthesisTableReference parenthesis:
                    foreach (var name in CorrelationNames(parenthesis.Join)) yield return name;
                    break;
                case TableReferenceWithAlias { Alias: { } alias }:
                    yield return alias;
                    break;
                case NamedTableReference named:
                    yield return named.SchemaObject.BaseIdentifier;
                    break;
            }
        }
    }
}
