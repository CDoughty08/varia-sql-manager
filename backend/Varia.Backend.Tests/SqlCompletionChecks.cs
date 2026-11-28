using Varia.Backend.Language;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

internal static class SqlCompletionChecks
{
    public static Task RunAsync(Action<bool, string> check)
    {
        var budget = new IndexBudget(1 << 22);
        var conn = new ConnectionIndex(budget);
        var leftTbl = new IndexedObject("table", "tables", "dbo", "LeftFixture");
        var rightTbl = new IndexedObject("table", "tables", "dbo", "RightFixture");
        var wideTbl = new IndexedObject("table", "tables", "dbo", "WideFixture");
        var rows = new List<IndexedObject>
        {
            leftTbl,
            new("column", "columns", null, "high", "table", "dbo", "LeftFixture"),
            new("column", "columns", null, "LeftOnly", "table", "dbo", "LeftFixture"),
            new("column", "columns", null, "id", "table", "dbo", "LeftFixture"),
            rightTbl,
            new("column", "columns", null, "high", "table", "dbo", "RightFixture"),
            new("column", "columns", null, "RightOnly", "table", "dbo", "RightFixture"),
            new("column", "columns", null, "id", "table", "dbo", "RightFixture"),
            wideTbl
        };
        for (var i = 0; i < 600; i++)
            rows.Add(new("column", "columns", null, "Alpha" + i.ToString("D3", System.Globalization.CultureInfo.InvariantCulture), "table", "dbo", "WideFixture"));
        rows.Add(new("column", "columns", null, "ZzzTail", "table", "dbo", "WideFixture"));

        conn.Put(new DatabaseIndex("Sales", ObjectTable.Of([.. rows]), 0, 0, 0) { CaseSensitive = false });
        var lookup = new IndexLookup(conn, budget, false, new LookupLedger().Snapshot());

        LanguageCompletionResult Complete(string marked)
        {
            var cursor = marked.IndexOf('|');
            var text = marked.Remove(cursor, 1);
            var req = new LanguageRequest(Guid.NewGuid().ToString(), 1, text, new("sqlserver", Guid.NewGuid().ToString(), "Sales"),
                SqlToolsLanguageService.EndPosition(text[..cursor]));
            return TsqlCompletionService.Complete(req, lookup, "Sales");
        }
        static bool Has(LanguageCompletionResult r, string label) => r.Items.Any(i => i.Label == label);

        // Scope resolution checks (parity with original AST suite)
        Scope(check, "SELECT | FROM dbo.LeftFixture AS t JOIN dbo.RightFixture AS b ON t.id=b.id", ["t", "b"], "blank SELECT resolves both joined aliases");
        Scope(check, "SELECT hi| FROM dbo.LeftFixture AS t JOIN dbo.RightFixture AS b ON t.id=b.id", ["t", "b"], "typed prefix preserves both joined aliases");
        Scope(check, "SELECT | FROM dbo.LeftFixture AS t JOIN dbo.RightFixture AS T ON t.id=T.id", ["t", "T"], "case-distinct aliases remain distinct");
        Scope(check, "SELECT | FROM dbo.LeftFixture AS [t]] one] JOIN dbo.RightFixture AS \"b\"\" two\" ON 1=1", ["[t]] one]", "\"b\"\" two\""], "delimited aliases preserve escaped brackets and quotes");
        Scope(check, "WITH q AS (SELECT i.high FROM dbo.LeftFixture i) SELECT | FROM q AS t JOIN q AS b ON 1=1", ["t", "b"], "CTE output scope excludes aliases inside its definition");
        Scope(check, "WITH q AS (SELECT | FROM dbo.LeftFixture i) SELECT * FROM q AS t", ["i"], "CTE definition sees its own table scope");
        Scope(check, "SELECT * FROM dbo.LeftFixture t WHERE EXISTS (SELECT | FROM dbo.RightFixture b WHERE b.id=t.id)", ["b", "t"], "correlated subquery sees inner then outer aliases");
        Scope(check, "SELECT * FROM dbo.LeftFixture t WHERE EXISTS (SELECT | FROM dbo.RightFixture t)", ["t"], "inner alias shadows the same outer correlation name");
        Scope(check, "SELECT * FROM (SELECT | FROM dbo.LeftFixture i) d JOIN dbo.RightFixture o ON 1=1", ["i"], "derived SELECT does not acquire sibling aliases");
        Scope(check, "SELECT * FROM dbo.LeftFixture t CROSS APPLY (SELECT | FROM dbo.RightFixture b WHERE b.id=t.id) d", ["b", "t"], "CROSS APPLY SELECT retains its lateral outer correlation names");
        Scope(check, "SELECT * FROM dbo.LeftFixture t OUTER APPLY (SELECT | FROM dbo.RightFixture b WHERE b.id=t.id) d", ["b", "t"], "OUTER APPLY SELECT retains its lateral outer correlation names");
        Scope(check, "SELECT * FROM dbo.LeftFixture t CROSS APPLY (SELECT |) d", ["t"], "APPLY without an inner FROM retains its lateral source");
        Scope(check, "SELECT * FROM dbo.LeftFixture t WHERE EXISTS (SELECT * FROM dbo.RightFixture b CROSS JOIN (SELECT | FROM dbo.LeftFixture i WHERE i.id=t.id) d)", ["i", "t"],
            "ordinary derived SELECT excludes immediate siblings while retaining higher outer correlations");
        Scope(check, "SELECT * FROM dbo.LeftFixture t UNION ALL SELECT | FROM dbo.RightFixture b", ["b"], "UNION branch does not acquire the other branch's alias");
        Scope(check, "SELECT |, 'FROM dbo.Fake f' FROM dbo.LeftFixture t -- JOIN dbo.Fake g", ["t"], "strings and comments cannot invent correlation names");
        Scope(check, "SELECT | FROM dbo.LeftFixture t JOIN dbo.RightFixture t ON 1=1", [], "duplicate ambiguous correlation names are excluded");

        // Stack-overflow safety bounds (deep nesting must never throw!)
        var deepParen = Complete("SELECT " + new string('(', 1000) + "|" + new string(')', 1000) + " FROM dbo.LeftFixture t");
        var deepUnary = Complete("SELECT " + string.Concat(Enumerable.Repeat("+ ", 1000)) + "| FROM dbo.LeftFixture t");
        var deepBinary = Complete("SELECT | FROM dbo.LeftFixture t WHERE " + string.Join(" OR ", Enumerable.Repeat("t.id=1", 1000)));
        check(deepParen.Items is not null && deepUnary.Items is not null && deepBinary.Items is not null,
            "deeply nested parens, unary chains, and binary expression trees stay bounded without stack overflow");

        // Qualified multi-source columns (in-process, zero buffer mutation!)
        var joined = Complete("SELECT hi| FROM dbo.LeftFixture t JOIN dbo.RightFixture b ON t.id=b.id");
        check(joined.Items.Any(item => item is { Label: "t.[high]", FilterText: "high", InsertText: "t.[high]", TextEdit.NewText: "t.[high]" })
            && joined.Items.Any(item => item is { Label: "b.[high]", FilterText: "high", InsertText: "b.[high]", TextEdit.NewText: "b.[high]" })
            && Has(joined, "t.[LeftOnly]") && !Has(joined, "b.[LeftOnly]")
            && Has(joined, "b.[RightOnly]") && !Has(joined, "t.[RightOnly]")
            && !Has(joined, "[high]")
            && joined.Items.Where(i => i.Kind == 5).All(i => i.TextEdit!.Range == new LanguageRange(new(0, 7), new(0, 9))),
            "multi-source SELECT qualifies each alias's own columns with bare FilterText and exact replacement span");

        // Explicit alias-dot returns only that source's columns without duplicating qualifier
        var dotted = Complete("SELECT t.| FROM dbo.LeftFixture t JOIN dbo.RightFixture b ON t.id=b.id");
        check(Has(dotted, "[high]") && Has(dotted, "[LeftOnly]") && !Has(dotted, "[RightOnly]")
            && dotted.Items.All(item => !item.Label.StartsWith("t.", StringComparison.Ordinal) && !item.Label.StartsWith("b.", StringComparison.Ordinal)),
            "typed alias-dot returns only that source's bracketed columns without duplicating qualifier");

        // Wide table 500-item cap + prefix match beyond first 500 declarations
        var wideBlank = Complete("SELECT w.| FROM dbo.WideFixture w");
        check(wideBlank.Items.Count == SqlToolsLanguageService.MaxCompletionItems && wideBlank.IsIncomplete,
            "wide table completion respects the 500-item response cap and marks incomplete");
        var widePrefix = Complete("SELECT w.Zzz| FROM dbo.WideFixture w");
        check(widePrefix.Items[0].Label == "[ZzzTail]" && widePrefix.Items[0].FilterText == "ZzzTail",
            "wide table prefix completion ranks ZzzTail first beyond the 500-item cap");

        // ORDER BY result aliases + colliding alias + duplicate output alias
        var orderAlias = Complete("SELECT t.LeftOnly + 1 AS ComputedOnly FROM dbo.LeftFixture t ORDER BY |");
        check(Has(orderAlias, "[ComputedOnly]") && !Has(orderAlias, "t.[ComputedOnly]")
            && Has(orderAlias, "t.[LeftOnly]") && !Has(orderAlias, "[LeftOnly]"),
            "ORDER BY retains semantic result aliases as bare names while source columns stay qualified");

        var collidingAlias = Complete("SELECT t.LeftOnly + 1 AS high FROM dbo.LeftFixture t JOIN dbo.RightFixture b ON 1=1 ORDER BY |");
        check(Has(collidingAlias, "[high]") && Has(collidingAlias, "t.[high]") && Has(collidingAlias, "b.[high]")
            && !Has(collidingAlias, "[LeftOnly]") && !Has(collidingAlias, "[RightOnly]"),
            "ORDER BY preserves a unique output alias colliding with source columns without restoring unrelated bare fields");

        var dupAlias = Complete("SELECT t.LeftOnly AS high, b.RightOnly AS high FROM dbo.LeftFixture t JOIN dbo.RightFixture b ON 1=1 ORDER BY |");
        check(!Has(dupAlias, "[high]") && Has(dupAlias, "t.[high]") && Has(dupAlias, "b.[high]"),
            "duplicate output aliases are excluded in ORDER BY");

        // Bracketed alias & auto-closed `[hi|]`
        var bracketed = Complete("SELECT hi| FROM dbo.LeftFixture AS [bob]");
        check(bracketed.Items.Any(i => i is { Label: "[bob].[high]", InsertText: "[bob].[high]", TextEdit.NewText: "[bob].[high]", FilterText: "high" }),
            "bracketed alias columns show and insert the bracketed alias and column name");

        const string autoClosedText = "SELECT [bob].[hi] FROM dbo.LeftFixture AS [bob]";
        var autoClosed = Complete("SELECT [bob].[hi|] FROM dbo.LeftFixture AS [bob]");
        var accepted = autoClosed.Items.FirstOrDefault(i => i.Label == "[high]");
        check(accepted?.TextEdit is { } edit
            && autoClosedText[..edit.Range.Start.Character] + edit.NewText + autoClosedText[edit.Range.End.Character..] == "SELECT [bob].[high] FROM dbo.LeftFixture AS [bob]",
            "accepting a column inside an auto-closed bracket replaces the closing bracket without doubling it");

        // Hostile ANSI `||` concat chain (SQL Server 2025) must be bounded before TSql180Parser.Parse so it never overflows the stack!
        var concatChain = "SELECT 'a'" + string.Concat(Enumerable.Repeat("||'a'", 7_500)) + " FROM dbo.LeftFixture t";
        var concatTokens = new Microsoft.SqlServer.TransactSql.ScriptDom.TSql180Parser(true).GetTokenStream(new StringReader(concatChain), out _);
        check(!SqlToolsLanguageService.BoundedCompletionSyntax(concatTokens),
            "BoundedCompletionSyntax rejects deeply chained || string concatenation before ScriptDom AST parsing");
        var concatResult = TsqlCompletionService.Complete(
            new LanguageRequest(Guid.NewGuid().ToString("D"), 1, concatChain, new("sqlserver", null, "Sales"), new(0, 7)),
            lookup, "Sales");
        check(concatResult.Items.Count > 0,
            "hostile || concat chain completes safely via bounded token-stream fallback without stack overflow");

        // Hostile chained method calls `x.m().m()...` (balanced parens) must also be bounded and never overflow the stack!
        var methodChain = "SELECT x" + string.Concat(Enumerable.Repeat(".m()", 3_500)) + " FROM dbo.LeftFixture t";
        var methodTokens = new Microsoft.SqlServer.TransactSql.ScriptDom.TSql180Parser(true).GetTokenStream(new StringReader(methodChain), out _);
        check(!SqlToolsLanguageService.BoundedCompletionSyntax(methodTokens),
            "BoundedCompletionSyntax rejects deeply chained method calls (.m().m()...) before ScriptDom AST parsing");
        var methodResult = TsqlCompletionService.Complete(
            new LanguageRequest(Guid.NewGuid().ToString("D"), 1, methodChain, new("sqlserver", null, "Sales"), new(0, 7)),
            lookup, "Sales");
        check(methodResult.Items.Count > 0,
            "hostile chained method calls complete safely via bounded token-stream fallback without stack overflow");

        conn.Dispose();
        return Task.CompletedTask;
    }

    private static void Scope(Action<bool, string> check, string marked, string[] expected, string name)
    {
        var cursor = marked.IndexOf('|');
        var text = marked.Remove(cursor, 1);
        var ctx = TsqlScopeReader.ReadCompletion(text, SqlToolsLanguageService.EndPosition(text[..cursor]), "Sales");
        var actual = ctx.Sources.Concat(ctx.OuterSources).Select(s => s.RawQualifier).ToArray();
        check(actual.SequenceEqual(expected), $"SQL completion AST ({name}): got [{string.Join(", ", actual)}]");
    }
}
