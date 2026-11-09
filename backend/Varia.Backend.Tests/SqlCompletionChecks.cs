using System.Text.Json;
using Varia.Backend.Language;

namespace Varia.Backend.Tests;

internal static class SqlCompletionChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static JsonElement Element(object value) => JsonSerializer.SerializeToElement(value, Json);

    public static async Task RunAsync(Action<bool, string> check)
    {
        var ranked = SqlToolsLanguageService.ReadCompletions(Element(new object[]
        {
            new { label = "@@high", kind = 12 }, new { label = "HIERARCHYID", kind = 3 },
            new { label = "high", kind = 5, sortText = "upstream", filterText = "high" }
        }));
        check(ranked.Items[0] is { Label: "high", SortText: "0:upstream", FilterText: "high" }
            && ranked.Items.Skip(1).All(item => item.SortText!.StartsWith("1:", StringComparison.Ordinal)),
            "SQL columns precede globals and functions and retain bounded provider sort/filter metadata");
        var crowded = Enumerable.Range(0, 600).Select(index => new { label = "@@global" + index, kind = 12 }).Cast<object>()
            .Append(new { label = "high", kind = 5 });
        var capped = SqlToolsLanguageService.ReadCompletions(Element(crowded));
        check(capped.Items[0].Label == "high" && capped.Items.Count == SqlToolsLanguageService.MaxCompletionItems && capped.IsIncomplete,
            "column ranking happens before the bounded response drops a catalog tail");

        Scope(check, "SELECT | FROM dbo.T AS t JOIN dbo.B AS b ON t.id=b.id", ["t", "b"], "blank SELECT resolves both joined aliases");
        Scope(check, "SELECT hi| FROM dbo.T AS t JOIN dbo.B AS b ON t.id=b.id", ["t", "b"], "typed prefix preserves both joined aliases");
        Scope(check, "SELECT | FROM dbo.T AS t JOIN dbo.B AS T ON t.id=T.id", ["t", "T"], "case-distinct aliases remain available to the native database binder");
        Scope(check, "SELECT t.| FROM dbo.T AS t JOIN dbo.B AS b ON t.id=b.id", null, "explicit qualifier uses native completion without adding another qualifier");
        Scope(check, "SELECT | FROM dbo.T AS [t]] one] JOIN dbo.B AS \"b\"\" two\" ON 1=1", ["[t]] one]", "\"b\"\" two\""], "delimited aliases preserve escaped brackets and quotes");
        Scope(check, "WITH q AS (SELECT i.high FROM dbo.InnerTable i) SELECT | FROM q AS t JOIN q AS b ON 1=1", ["t", "b"], "CTE output scope excludes aliases inside its definition");
        Scope(check, "WITH q AS (SELECT | FROM dbo.InnerTable i) SELECT * FROM q AS t", ["i"], "CTE definition sees its own table scope");
        Scope(check, "SELECT * FROM dbo.T t WHERE EXISTS (SELECT | FROM dbo.B b WHERE b.id=t.id)", ["b", "t"], "correlated subquery sees inner then outer aliases");
        Scope(check, "SELECT * FROM dbo.T t WHERE EXISTS (SELECT | FROM dbo.B t)", ["t"], "inner alias shadows the same outer correlation name");
        Scope(check, "SELECT * FROM dbo.T t WHERE EXISTS (SELECT | FROM dbo.B T)", ["T", "t"], "case-distinct nested correlation names remain distinct for case-sensitive databases");
        Scope(check, "SELECT * FROM (SELECT | FROM dbo.InnerTable i) d JOIN dbo.OuterTable o ON 1=1", ["i"], "derived SELECT does not acquire sibling aliases");
        Scope(check, "SELECT * FROM dbo.T t UNION ALL SELECT | FROM dbo.B b", ["b"], "UNION branch does not acquire the other branch's alias");
        Scope(check, "SELECT |, 'FROM dbo.Fake f' FROM dbo.T t -- JOIN dbo.Fake g", ["t"], "strings and comments cannot invent correlation names");
        Scope(check, "SELECT * FROM |", null, "table-name position does not become a column scope");
        Scope(check, "SELECT | FROM dbo.T t JOIN", null, "incomplete invalid syntax declines speculative qualification");
        Scope(check, "SELECT | FROM dbo.T t JOIN dbo.B t ON 1=1", null, "duplicate ambiguous correlation names are never guessed");
        Scope(check, "SELECT " + new string('(', 1000) + "|" + new string(')', 1000) + " FROM dbo.T t", null,
            "deeply nested expressions decline in-process parsing without overflowing the backend stack");
        Scope(check, "SELECT " + string.Concat(Enumerable.Repeat("+ ", 1000)) + "| FROM dbo.T t", null,
            "deep unary expressions are bounded before the recursive grammar runs");
        Scope(check, "SELECT | FROM dbo.T t WHERE " + string.Join(" OR ", Enumerable.Repeat("t.id=1", 1000)), null,
            "deep binary expression trees are bounded before recursive parser and AST visits");

        var fake = new CompletionClient();
        using (var provider = new SqlToolsLanguageService(_ => null, createClient: _ => fake))
        {
            const string text = "SELECT hi FROM dbo.LeftFixture t JOIN dbo.RightFixture b ON t.id=b.id";
            var request = new LanguageRequest(Guid.NewGuid().ToString(), 1, text, new("sqlserver"), new(0, 9));
            var result = await provider.CompleteAsync(request, default);
            check(result.Items.Any(item => item is { Label: "t.high", FilterText: "high", InsertText: "t.high", TextEdit.NewText: "t.high" })
                && result.Items.Any(item => item is { Label: "b.high", FilterText: "high", TextEdit.NewText: "b.high" })
                && result.Items.Any(item => item.Label == "t.LeftOnly") && !result.Items.Any(item => item.Label == "b.LeftOnly")
                && result.Items.Any(item => item.Label == "b.RightOnly") && !result.Items.Any(item => item.Label == "t.RightOnly")
                && !result.Items.Any(item => item.Label == "high"),
                "distinct qualified suggestions use each alias's own semantic column result with a bare prefix filter");
            check(result.Items.Where(item => item.Kind == 5).All(item => item.TextEdit!.Range == new LanguageRange(new(0, 7), new(0, 9)))
                && fake.Text == text && fake.Versions.SequenceEqual(fake.Versions.Order()) && fake.Versions.Distinct().Count() == fake.Versions.Count,
                "alias probes replace the original prefix and restore exact SQL under monotonic remote versions");
            await provider.HoverAsync(request, default);
            check(fake.Completions.Last() == text, "hover reparses restored SQL after contextual alias probes");
            var qualified = request with { Version = 2, Text = text.Replace("hi", "t.", StringComparison.Ordinal), Position = new(0, 9) };
            var single = await provider.CompleteAsync(qualified, default);
            check(single.Items.Any(item => item.Label == "high" && item.TextEdit!.NewText == "high")
                && single.Items.All(item => !item.Label.StartsWith("b.", StringComparison.Ordinal)),
                "typed alias-dot returns only its native columns and does not duplicate its qualifier");
        }

        var held = new CompletionClient { HoldProbe = true };
        using (var provider = new SqlToolsLanguageService(_ => null, createClient: _ => held))
        using (var stop = new CancellationTokenSource())
        {
            const string text = "SELECT  FROM dbo.T t JOIN dbo.B b ON 1=1";
            var pending = provider.CompleteAsync(new(Guid.NewGuid().ToString(), 1, text, new("sqlserver"), new(0, 7)), stop.Token);
            await held.ProbeRequested.Task.WaitAsync(TimeSpan.FromSeconds(15));
            stop.Cancel();
            try { await pending; check(false, "contextual completion cancellation propagates"); }
            catch (OperationCanceledException) { check(held.Text == text && !held.Disposed, "cancelled alias probe restores the original SQL before releasing its document gate"); }
        }
        var wide = new CompletionClient { WideColumns = true };
        using (var provider = new SqlToolsLanguageService(_ => null, createClient: _ => wide))
        {
            const string text = "SELECT Zzz FROM dbo.T t JOIN dbo.B b ON 1=1";
            var result = await provider.CompleteAsync(new(Guid.NewGuid().ToString(), 1, text, new("sqlserver"), new(0, 10)), default);
            check(result.IsIncomplete && result.Items.Count == SqlToolsLanguageService.MaxCompletionItems
                && result.Items.Any(item => item.Label == "t.ZzzTail") && result.Items.Any(item => item.Label == "b.ZzzTail"),
                "bounded semantic expansion retains both prefix matches beyond each alias's first 500 declarations");
        }
        var failed = new CompletionClient { FailProbeWrite = true };
        using (var provider = new SqlToolsLanguageService(_ => null, createClient: _ => failed))
        {
            const string text = "SELECT  FROM dbo.T t";
            try
            {
                await provider.CompleteAsync(new(Guid.NewGuid().ToString(), 1, text, new("sqlserver"), new(0, 7)), default);
                check(false, "an uncertain probe-buffer mutation fails safely");
            }
            catch (RequestException error) { check(error.Code == "BACKEND_UNAVAILABLE" && failed.Disposed, "uncertain probe-buffer mutation retires its native client instead of reusing unknown SQL"); }
        }
        var resultAlias = new CompletionClient { BaselineColumns = ["high", "LeftOnly", "ComputedOnly"] };
        using (var provider = new SqlToolsLanguageService(_ => null, createClient: _ => resultAlias))
        {
            const string text = "SELECT t.LeftOnly + 1 AS ComputedOnly FROM dbo.LeftFixture t ORDER BY ";
            var result = await provider.CompleteAsync(new(Guid.NewGuid().ToString(), 1, text, new("sqlserver"), new(0, text.Length)), default);
            check(result.Items.Any(item => item.Label == "ComputedOnly") && !result.Items.Any(item => item.Label == "t.ComputedOnly")
                && result.Items.Any(item => item.Label == "t.LeftOnly") && !result.Items.Any(item => item.Label == "LeftOnly"),
                "semantic result aliases survive ORDER BY expansion while source columns remain qualified");
        }
    }

    private static void Scope(Action<bool, string> check, string marked, string[]? expected, string name)
    {
        var cursor = marked.IndexOf('|');
        var text = marked.Remove(cursor, 1);
        var start = cursor;
        while (start > 0 && char.IsLetterOrDigit(text[start - 1])) start--;
        var range = new LanguageRange(SqlToolsLanguageService.EndPosition(text[..start]), SqlToolsLanguageService.EndPosition(text[..cursor]));
        var array = Element(new[] { new { label = "high", kind = 5, textEdit = new { range, newText = "high" } } });
        var actual = SqlToolsLanguageService.ResolveCompletionScope(array, text, range.End);
        check(expected is null ? actual is null : actual is not null && actual.Qualifiers.SequenceEqual(expected), "SQL completion AST: " + name);
    }

    private sealed class CompletionClient : ILspClient
    {
        private readonly TaskCompletionSource lifetime = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task Completion => lifetime.Task;
        public string Text = "";
        public bool Disposed;
        public bool HoldProbe;
        public bool WideColumns;
        public bool FailProbeWrite;
        public string[] BaselineColumns = ["high", "LeftOnly", "RightOnly"];
        public readonly List<int> Versions = [];
        public readonly List<string> Completions = [];
        public readonly TaskCompletionSource ProbeRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task NotifyAsync(string method, object? parameters, CancellationToken token = default)
        {
            token.ThrowIfCancellationRequested();
            var value = Element(parameters!);
            if (method is "textDocument/didOpen" or "textDocument/didChange")
            {
                Versions.Add(value.GetProperty("textDocument").GetProperty("version").GetInt32());
                Text = method.EndsWith("didOpen", StringComparison.Ordinal) ? value.GetProperty("textDocument").GetProperty("text").GetString()!
                    : value.GetProperty("contentChanges")[0].GetProperty("text").GetString()!;
                if (FailProbeWrite && Text.StartsWith("SELECT t.", StringComparison.Ordinal)) throw new IOException("uncertain transport write");
            }
            return Task.CompletedTask;
        }
        public async Task<JsonElement> RequestAsync(string method, object? parameters, CancellationToken token = default, TimeSpan? timeout = null)
        {
            if (method == "textDocument/hover") return Element(new { contents = "int" });
            if (method != "textDocument/completion") return Element(true);
            Completions.Add(Text);
            var position = Element(parameters!).GetProperty("position");
            var cursor = position.GetProperty("character").GetInt32();
            var orderBy = Text.LastIndexOf("ORDER BY ", StringComparison.Ordinal);
            var start = orderBy < 0 ? 7 : orderBy + "ORDER BY ".Length;
            var before = Text[start..cursor];
            var isLeft = before.StartsWith("t.", StringComparison.Ordinal);
            var isRight = before.StartsWith("b.", StringComparison.Ordinal);
            if (isLeft && HoldProbe)
            {
                ProbeRequested.TrySetResult();
                await Task.Delay(Timeout.Infinite, token);
            }
            string[] columns = isLeft ? ["high", "LeftOnly"] : isRight ? ["high", "RightOnly"] : BaselineColumns;
            if (WideColumns) columns = Enumerable.Range(0, 600).Select(index => "Alpha" + index).Append("ZzzTail").ToArray();
            var range = new LanguageRange(new(0, start + (isLeft || isRight ? 2 : 0)), new(0, cursor));
            return Element(columns.Select(label => new { label, kind = 5, insertText = label, textEdit = new { range, newText = label } }));
        }
        public void Dispose() { Disposed = true; lifetime.TrySetResult(); }
    }
}
