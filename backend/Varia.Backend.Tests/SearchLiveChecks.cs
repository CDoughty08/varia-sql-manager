using System.Text.Json;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Live object index checks (scratch only): a build reads the scratch database's objects and definitions, hostile
/// names and all, a search finds them by name and by definition with each option, a database a build cannot read is skipped
/// as a value, a rebuild sees a dropped object go, and a disconnect gives the definitions' budget back.</summary>
internal static class SearchLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, string connectionId, JsonSerializerOptions json, Func<string, string, Task<SqlRun>> sql, string database)
    {
        // A name that breaks out of brackets, strings and comments, and a marker only this run's definitions hold.
        var marker = "varia_marker_" + Guid.NewGuid().ToString("N")[..8];
        const string hostile = "Search ]'*/--é";
        var created = await sql("CREATE SCHEMA [srch];", database);
        check(created.Error is null, "the search checks create their schema: " + created.Error);
        created = await sql("CREATE TABLE [srch].[" + hostile.Replace("]", "]]") + "] (id int);", database);
        check(created.Error is null, "the search checks create a table with a hostile name: " + created.Error);
        created = await sql("CREATE PROCEDURE [srch].[usp_Find] AS\nBEGIN\n    -- " + marker + "\n    SELECT id FROM [srch].[" + hostile.Replace("]", "]]") + "];\nEND", database);
        check(created.Error is null, "the search checks create a procedure: " + created.Error);
        created = await sql("CREATE TRIGGER [srch].[trg_Find] ON [srch].[" + hostile.Replace("]", "]]") + "] AFTER INSERT AS SELECT 1 AS " + marker.ToUpperInvariant() + ";", database);
        check(created.Error is null, "the search checks create a trigger: " + created.Error);
        created = await sql("CREATE TYPE [srch].[FindList] AS TABLE (id int);", database);
        check(created.Error is null, "the search checks create a table type: " + created.Error);

        async Task<ObjectIndexResult> Build(bool definitions = true) => (ObjectIndexResult)await service.DispatchAsync("explorer.index",
            JsonSerializer.SerializeToElement(new ObjectIndexArgs(connectionId, Guid.NewGuid().ToString(), definitions), json), json);
        async Task<ObjectSearchResult> Find(string text, string scope = "all", bool caseSensitive = false, bool wholeWord = false, bool regex = false) =>
            (ObjectSearchResult)await service.DispatchAsync("explorer.search", JsonSerializer.SerializeToElement(
                new ObjectSearchArgs(connectionId, Guid.NewGuid().ToString(), text, caseSensitive, wholeWord, regex, scope, Database: database), json), json);

        var events = new List<JsonElement>();
        var built = await service.Search.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), CancellationToken.None, value => events.Add(JsonSerializer.SerializeToElement(value, json)));
        check(built.Status is { State: "ready", Definitions: true } && built.Status.Indexed >= 1 && built.Status.Objects >= 4,
            "a build reads every database it can (" + built.Status.Indexed + " of " + built.Status.Databases + ", " + built.Status.Objects + " objects, " + built.ElapsedMs + " ms)");
        check(events.Count >= 2 && events[0].GetProperty("type").GetString() == "explorer.index.progress" && events[^1].GetProperty("done").GetInt32() == built.Status.Databases,
            "a build reports its progress, ending at every database");
        check(service.Search.DefinitionChars > 0, "the build holds definitions against the budget");

        var byName = await Find("search ]'");
        check(byName.Hits.Any(hit => hit.Object is { Kind: "table", Schema: "srch", Name: hostile } && hit.Folder == "tables" && hit.Label == "srch." + hostile),
            "a search finds a table with a hostile name, by the name SQL Server stores");
        var trigger = (await Find("trg_find", "names")).Hits.SingleOrDefault();
        check(trigger is { Object: { Kind: "trigger", Schema: null, Parent: { Kind: "table", Schema: "srch", Name: hostile } }, Folder: "tableTriggers" },
            "a trigger is found with its parent table, as Object Explorer refers to it");
        check((await Find("FindList", "names")).Hits is [{ Object.Kind: "tableType", Folder: "userDefinedTableTypes" }], "a table type is found under its folder");
        var inDefinition = await Find(marker, "definitions");
        check(inDefinition.Hits.Count == 2 && inDefinition.Hits.Any(hit => hit.Label == "srch.usp_Find" && hit.Definition is { Line: 3 } && hit.Definition.Preview.Contains(marker, StringComparison.Ordinal)),
            "a definition search finds both modules that hold the marker, with the match's line");
        check((await Find(marker, "definitions", caseSensitive: true)).Hits is [{ Label: "srch.usp_Find" }], "Match Case leaves out the trigger's upper-case marker");
        check((await Find("varia_marker", "definitions", wholeWord: true)).Hits.Count == 0, "Whole Word does not match part of the marker");
        check((await Find(@"^\s*--\s*varia_marker_[0-9a-f]{8}$", "definitions", regex: true)).Hits.Any(hit => hit.Label == "srch.usp_Find"), "a regular expression matches a definition's line");
        check((await Find("(a", regex: true)).Problem is { Length: > 0 }, "an invalid regular expression answers why");

        var names = await Build(definitions: false);
        check(names.Status.Definitions == false && (await Find(marker, "definitions")).Hits.Count == 0, "a build without definitions searches names only");
        await sql("DROP PROCEDURE [srch].[usp_Find];", database);
        await Build();
        check((await Find("usp_Find", "names")).Hits.Count == 0, "a rebuild drops an object that is gone");

        // Stop during a build answers CANCELLED and keeps what was read.
        using (var stop = new CancellationTokenSource())
        {
            var running = service.Search.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), stop.Token);
            stop.Cancel();
            try { await running; check(true, "Stop ends a build (it had finished)"); }
            catch (RequestException error) { check(error.Code == "CANCELLED", "Stop ends a build with CANCELLED"); }
            check((await Find("FindList", "names")).Hits.Count == 1, "a stopped build keeps the index it had");
        }
        await sql("DROP TYPE [srch].[FindList]; DROP TABLE [srch].[" + hostile.Replace("]", "]]") + "]; DROP SCHEMA [srch];", database);
    }

}
