using System.Text.Json;
using Varia.Backend.Language;

namespace Varia.Backend.Tests;

internal static class SqlCompletionLiveChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // Reuse the language suite's marked fixture database and process lifecycle checks.
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo connection)
    {
        var id = Guid.NewGuid().ToString();
        var version = 0;
        async Task<LanguageCompletionResult> Complete(string marked)
        {
            var cursor = marked.IndexOf('|');
            var text = marked.Remove(cursor, 1);
            var request = new LanguageRequest(id, ++version, text, new("sqlserver", connection.Id, connection.Database),
                SqlToolsLanguageService.EndPosition(text[..cursor]));
            return (LanguageCompletionResult)await service.DispatchAsync("language.complete", JsonSerializer.SerializeToElement(request, Json), Json);
        }
        static bool Has(LanguageCompletionResult result, string label) => result.Items.Any(item => item.Label.Equals(label, StringComparison.Ordinal));
        try
        {
            var blank = await Complete("SELECT | FROM dbo.LanguageFixture AS t JOIN dbo.LanguageFixture AS b ON t.FirstOnly=b.FirstOnly;");
            check(Has(blank, "t.SharedName") && Has(blank, "b.SharedName") && !Has(blank, "SharedName")
                && blank.Items.TakeWhile(item => item.Kind == 5).Any(),
                "live blank SELECT offers distinct joined column names ahead of globals and functions");
            const string sources = "WITH leftSource AS (SELECT FirstOnly AS high, FirstOnly AS LeftOnly FROM dbo.LanguageFixture), rightSource AS (SELECT EditedOnly AS high, EditedOnly AS RightOnly FROM dbo.EditedFixture) ";
            var typed = await Complete(sources + "SELECT hi| FROM leftSource AS t CROSS JOIN rightSource AS b;");
            check(Has(typed, "t.high") && Has(typed, "b.high") && Has(typed, "t.LeftOnly") && Has(typed, "b.RightOnly")
                && !Has(typed, "t.RightOnly") && !Has(typed, "b.LeftOnly")
                && typed.Items.Where(item => item.Label is "t.high" or "b.high").All(item => item.FilterText == "high"
                    && item.TextEdit is { NewText: "t.high" or "b.high" } && item.TextEdit.Range.Start.Character + 2 == item.TextEdit.Range.End.Character),
                "live typed hi retains both semantic CTE aliases and inserts its own qualified column over the prefix");
            var qualified = await Complete(sources + "SELECT t.| FROM leftSource AS t CROSS JOIN rightSource AS b;");
            check(Has(qualified, "high") && Has(qualified, "LeftOnly") && !Has(qualified, "RightOnly")
                && qualified.Items.Where(item => item.Kind == 5).All(item => !item.TextEdit!.NewText.StartsWith("t.", StringComparison.Ordinal)),
                "live explicit t-dot keeps only t's columns and inserts no second qualifier");
            var quoted = await Complete(sources + "SELECT | FROM leftSource AS [t]] one] CROSS JOIN rightSource AS \"b\"\" two\";");
            check(Has(quoted, "[t]] one].high") && Has(quoted, "\"b\"\" two\".high")
                && !Has(quoted, "[t]] one].RightOnly"),
                "live semantic qualification preserves escaped quoted aliases");
            var nested = await Complete("SELECT * FROM dbo.LanguageFixture AS outerAlias WHERE EXISTS (SELECT | FROM dbo.EditedFixture AS innerAlias WHERE innerAlias.EditedOnly=outerAlias.FirstOnly);");
            check(Has(nested, "innerAlias.EditedOnly") && Has(nested, "outerAlias.FirstOnly")
                && !Has(nested, "innerAlias.FirstOnly") && !Has(nested, "outerAlias.EditedOnly"),
                "live correlated SELECT retains the correct semantic membership of inner and outer aliases");
            var derived = await Complete("SELECT * FROM (SELECT | FROM dbo.LanguageFixture AS insideAlias) AS derivedAlias CROSS JOIN dbo.EditedFixture AS outsideAlias;");
            check(Has(derived, "insideAlias.FirstOnly") && !derived.Items.Any(item => item.Label.StartsWith("outsideAlias.", StringComparison.Ordinal)
                || item.Label.StartsWith("derivedAlias.", StringComparison.Ordinal)),
                "live derived-table SELECT does not qualify sibling or containing aliases");
            var outputAlias = await Complete("SELECT t.FirstOnly + 1 AS ComputedOnly FROM dbo.LanguageFixture AS t ORDER BY |;");
            check(Has(outputAlias, "ComputedOnly") && !Has(outputAlias, "t.ComputedOnly"),
                "live ORDER BY retains a semantic result alias that is not a table column");
            var caseDistinct = await Complete("SELECT | FROM dbo.LanguageFixture AS t CROSS JOIN dbo.EditedFixture AS T;");
            check(Has(caseDistinct, "t.FirstOnly") && Has(caseDistinct, "T.EditedOnly")
                && !Has(caseDistinct, "t.EditedOnly") && !Has(caseDistinct, "T.FirstOnly"),
                "live case-sensitive scratch database preserves distinct lowercase and uppercase table aliases");
        }
        finally { await service.DispatchAsync("language.close", JsonSerializer.SerializeToElement(new LanguageCloseArgs(id), Json), Json); }
    }
}
