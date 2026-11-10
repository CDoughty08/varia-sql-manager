using System.Text.Json;
using Varia.Backend.Language;

namespace Varia.Backend.Tests;

internal static class SqlLanguageDiagnosticLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo first, ConnectionInfo second,
        Func<string, string, Task<SqlRun>> sql)
    {
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var id = Guid.NewGuid().ToString("D");
        var secondId = Guid.NewGuid().ToString("D");
        async Task<LanguageDiagnosticResult> Analyze(string document, int version, string text, ConnectionInfo connection) =>
            (LanguageDiagnosticResult)await service.DispatchAsync("language.diagnostics", JsonSerializer.SerializeToElement(
                new LanguageRefreshRequest(document, version, text, new("sqlserver", connection.Id, connection.Database)), json), json);
        static bool Mentions(LanguageDiagnosticResult result, string name) => result.Items.Any(item => item.Message.Contains(name, StringComparison.OrdinalIgnoreCase));
        try
        {
            var missing = await Analyze(id, 1, "SELECT f.MissingLanguageColumn FROM dbo.LanguageFixture AS f;", first);
            check(missing.Version == 1 && Mentions(missing, "MissingLanguageColumn") && missing.Items.All(item => item.Severity is >= 1 and <= 4),
                "bundled SQL Tools binder publishes a missing live column diagnostic without executing the buffer");
            var fixedColumn = await Analyze(id, 2, "SELECT f.FirstOnly FROM dbo.LanguageFixture AS f;", first);
            check(fixedColumn.Version == 2 && fixedColumn.Items.Count == 0 && !fixedColumn.IsIncomplete,
                "fixing an unsaved column clears old semantic diagnostics in one immutable analysis pass");
            const string refreshedText = "SELECT f.DiagnosticRefreshedOnly FROM dbo.LanguageFixture AS f;";
            var beforeRefresh = await Analyze(id, 3, refreshedText, first);
            check(Mentions(beforeRefresh, "DiagnosticRefreshedOnly"), "diagnostic refresh regression warms metadata before adding a fixture column");
            check((await sql("ALTER TABLE dbo.LanguageFixture ADD DiagnosticRefreshedOnly int NULL;", first.Database)).Status == "completed",
                "diagnostic refresh fixture changes only the owned scratch table");
            var refresh = (LanguageRefreshResult)await service.DispatchAsync("language.refresh", JsonSerializer.SerializeToElement(
                new LanguageRefreshRequest(id, 3, refreshedText, new("sqlserver", first.Id, first.Database)), json), json);
            var afterRefresh = await Analyze(id, 4, refreshedText, first);
            check(refresh.Refreshed && afterRefresh.Items.Count == 0, "cache refresh invalidates retained diagnostic binding metadata and clears a newly valid column error");
            var alias = await Analyze(id, 5, "SELECT missingAlias.FirstOnly FROM dbo.LanguageFixture AS f;", first);
            check(alias.Items.Count > 0 && Mentions(alias, "missingAlias"), "bundled SQL Tools binder diagnoses an unknown table alias");
            var syntax = await Analyze(id, 6, "SELECT ( FROM dbo.LanguageFixture;", first);
            check(syntax.Items.Count > 0 && syntax.Items.All(item => SqlToolsLanguageService.PositionInText("SELECT ( FROM dbo.LanguageFixture;", item.Range.Start)
                && SqlToolsLanguageService.PositionInText("SELECT ( FROM dbo.LanguageFixture;", item.Range.End)),
                "bundled SQL Tools parser publishes syntax diagnostics with valid document ranges");
            const string sharedText = "SELECT f.SecondOnly FROM dbo.LanguageFixture AS f;";
            var wrongDatabase = await Analyze(id, 7, sharedText, first);
            var correctDatabase = await Analyze(secondId, 1, sharedText, second);
            check(Mentions(wrongDatabase, "SecondOnly") && correctDatabase.Items.Count == 0,
                "identical diagnostic SQL binds to each query document's own database metadata");
            var neverExecute = await Analyze(secondId, 2, "THROW 51000, 'Language diagnostics must not execute this buffer', 1;", second);
            check(neverExecute.Version == 2 && neverExecute.Items.Count == 0,
                "a valid THROW statement is analyzed as text and never executed against SQL Server");
        }
        finally
        {
            foreach (var document in new[] { id, secondId })
                await service.DispatchAsync("language.close", JsonSerializer.SerializeToElement(new LanguageCloseArgs(document), json), json);
        }
    }
}
