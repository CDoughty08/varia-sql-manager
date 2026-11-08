using System.Text.Json;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Live object index checks (scratch only): a build reads the scratch database's objects and definitions, hostile
/// names and all, and every other kind Object Explorer lists (logins, server roles and databases; users, roles and schemas;
/// columns, keys, constraints, indexes and parameters, with constraint and computed column expressions as definitions), a search
/// finds them by name and by definition with each option, a database a build cannot read is skipped as a value, a rebuild sees a
/// dropped object go, and a disconnect gives the definitions' budget back.</summary>
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
        // Children, principals and constraint expressions, with a second marker only the default constraint holds.
        var constant = "varia_default_" + Guid.NewGuid().ToString("N")[..8];
        created = await sql("CREATE TABLE [srch].[Priced] (id int CONSTRAINT [pk_srch_priced] PRIMARY KEY, price money CONSTRAINT [ck_srch_price] CHECK (price >= 0),"
            + " srch_total AS (price * 7), note nvarchar(40) CONSTRAINT [df_srch_note] DEFAULT (N'" + constant + "'));", database);
        check(created.Error is null, "the search checks create a table with keys, constraints and a computed column: " + created.Error);
        created = await sql("CREATE INDEX [ix_srch_price] ON [srch].[Priced] (price); EXEC (N'CREATE PROCEDURE [srch].[usp_Param] @srch_param int AS SELECT @srch_param;');"
            + " CREATE USER [srch_user] WITHOUT LOGIN; CREATE ROLE [srch_role];", database);
        check(created.Error is null, "the search checks create an index, a procedure with a parameter, a user and a role: " + created.Error);
        created = await sql("CREATE TABLE [srch].[Rates] (id int PRIMARY KEY, rate money, valid_from datetime2 GENERATED ALWAYS AS ROW START, valid_to datetime2 GENERATED ALWAYS AS ROW END,"
            + " PERIOD FOR SYSTEM_TIME (valid_from, valid_to)) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = [srch].[Rates_Archive])); CREATE TABLE [srch].[Person] (person_name nvarchar(40)) AS NODE;", database);
        check(created.Error is null, "the search checks create a temporal table and a graph node table: " + created.Error);

        async Task<ObjectIndexResult> Build(bool definitions = true) => (ObjectIndexResult)await service.DispatchAsync("explorer.index",
            JsonSerializer.SerializeToElement(new ObjectIndexArgs(connectionId, Guid.NewGuid().ToString(), definitions), json), json);
        async Task<ObjectSearchResult> Find(string text, string scope = "all", bool caseSensitive = false, bool wholeWord = false, bool regex = false) =>
            await FindIn(database, text, scope, caseSensitive, wholeWord, regex);
        async Task<ObjectSearchResult> FindIn(string? inDatabase, string text, string scope = "all", bool caseSensitive = false, bool wholeWord = false, bool regex = false) =>
            (ObjectSearchResult)await service.DispatchAsync("explorer.search", JsonSerializer.SerializeToElement(
                new ObjectSearchArgs(connectionId, Guid.NewGuid().ToString(), text, caseSensitive, wholeWord, regex, scope, Database: inDatabase), json), json);

        var events = new List<JsonElement>();
        var built = await service.Search.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), CancellationToken.None, value => events.Add(JsonSerializer.SerializeToElement(value, json)));
        check(built.Status is { State: "ready", Definitions: true } && built.Status.Indexed >= 1 && built.Status.Objects >= 4,
            "a build reads every database it can (" + built.Status.Indexed + " of " + built.Status.Databases + ", " + built.Status.Objects + " objects, " + built.ElapsedMs + " ms)");
        check(events.Count >= 2 && events[0].GetProperty("type").GetString() == "explorer.index.progress" && events[^1].GetProperty("done").GetInt32() == built.Status.Databases,
            "a build reports its progress, ending at every database");
        check(service.Search.MemoryUsed > 0, "the build holds its objects and definitions against the memory budget");

        // Microsoft-shipped objects are indexed as Object Explorer lists them: master's own under System Tables, and the resource
        // database's (sys.sp_who) once per server, not once per database.
        check((await FindIn("master", "spt_fallback_db", "names")).Hits.Any(hit => hit.Object is { Kind: "table", Schema: "dbo", Name: "spt_fallback_db", Database: "master" } && hit.Folder == "systemTables"),
            "master's spt_fallback_db is found under System Tables");
        var who = (await FindIn(null, "sp_who", "names", wholeWord: true)).Hits;
        check(who is [{ Object: { Kind: "procedure", Schema: "sys", Name: "sp_who", Database: "master" }, Folder: "systemStoredProcedures" }],
            "a resource database procedure is one hit for the whole server, under master: " + string.Join(", ", who.Select(hit => hit.Object.Database + ":" + hit.Label)));
        check(service.Search.Resources.Sets == 1, "the build holds one shared set of the resource database's objects");
        var memoryBefore = service.Search.MemoryUsed;

        var byName = await Find("search ]'");
        check(byName.Hits.Any(hit => hit.Object is { Kind: "table", Schema: "srch", Name: hostile } && hit.Folder == "tables" && hit.Label == "srch." + hostile),
            "a search finds a table with a hostile name, by the name SQL Server stores");
        var trigger = (await Find("trg_find", "names")).Hits.SingleOrDefault();
        check(trigger is { Object: { Kind: "trigger", Schema: null, Parent: { Kind: "table", Schema: "srch", Name: hostile } }, Folder: "tableTriggers" },
            "a trigger is found with its parent table, as Object Explorer refers to it");
        check((await Find("FindList", "names")).Hits is [{ Object.Kind: "tableType", Folder: "userDefinedTableTypes" }], "a table type is found under its folder");

        // Every other kind Object Explorer lists, each with its ref and folder.
        check((await Find("srch_user", "names")).Hits.Any(hit => hit.Object is { Kind: "user", Schema: null, Name: "srch_user" } && hit.Object.Database == database && hit.Folder == "users"),
            "a database user is found under Security › Users");
        check((await Find("srch_role", "names")).Hits.Any(hit => hit.Object is { Kind: "databaseRole", Name: "srch_role" } && hit.Folder == "databaseRoles"), "a database role is found");
        check((await Find("srch", "names", wholeWord: true)).Hits.Any(hit => hit.Object is { Kind: "schema", Name: "srch" } && hit.Folder == "schemas" && hit.Range is [0, 4]),
            "a schema is found as an exact name");
        var keys = (await Find("pk_srch_priced", "names")).Hits;
        check(keys.Any(hit => hit.Object is { Kind: "key", Parent: { Kind: "table", Schema: "srch", Name: "Priced" } } && hit.Subtype == "primary" && hit.ParentFolder == "tables" && hit.Label == "srch.Priced.pk_srch_priced")
            && keys.Any(hit => hit.Object.Kind == "index") && keys.Any(hit => hit.Object.Kind == "statistic"),
            "a primary key is found as a key, and as the index and statistics Object Explorer lists for it: " + string.Join(", ", keys.Select(hit => hit.Object.Kind + ":" + hit.Label)));
        check((await Find("ix_srch_price", "names")).Hits.Any(hit => hit.Object is { Kind: "index", Name: "ix_srch_price" } && hit.Subtype == "nonclustered" && hit.Folder == "indexes"),
            "an index is found with its subtype");
        check((await Find("ck_srch_price", "names")).Hits.Any(hit => hit.Object.Kind == "constraint" && hit.Subtype == "check" && hit.Folder == "constraints"), "a check constraint is found");
        check((await Find("srch_total", "names")).Hits.Any(hit => hit.Object is { Kind: "column", Name: "srch_total", Parent.Name: "Priced" } && hit.Folder == "columns"), "a column is found under its table");
        check((await Find("@srch_param", "names")).Hits.Any(hit => hit.Object is { Kind: "parameter", Parent: { Kind: "procedure", Name: "usp_Param" } } && hit.Subtype == "input" && hit.ParentFolder == "storedProcedures"),
            "a parameter is found under its procedure");
        check((await Find(constant, "definitions")).Hits is [{ Object.Kind: "constraint", Subtype: "default", Definition.Matches: 1 }], "a default constraint's expression is searched as its definition");
        check((await Find("[price]*(7)", "definitions")).Hits.Any(hit => hit.Object is { Kind: "column", Name: "srch_total" } && hit.Definition is not null),
            "a computed column's expression is searched as its definition");
        check((await Find("[price]>=(0)", "definitions")).Hits.Any(hit => hit.Object is { Kind: "constraint", Name: "ck_srch_price" }), "a check constraint's expression is searched as its definition");
        // A history table and its columns are shown below their temporal table; a node table's hidden columns are not shown at all.
        check((await Find("Rates_Archive", "names")).Hits.Any(hit => hit.Object is { Kind: "table", Name: "Rates_Archive" } && hit.Subtype == "history" && hit.Via is { Schema: "srch", Name: "Rates", Folder: "tables" }),
            "a temporal history table is found with the table whose history row shows it");
        check((await Find("rate", "names", wholeWord: true)).Hits.Any(hit => hit.Object.Parent is { Name: "Rates_Archive" } && hit.Via is { Name: "Rates" }),
            "a history table's column names the table that shows its parent");
        var person = (await Find("Person", "names")).Hits;
        check(person.Any(hit => hit.Object is { Kind: "table", Name: "Person" } && hit.Folder == "graphTables" && hit.Subtype == "graphNode")
            && (await Find("graph_id", "names")).Hits.All(hit => hit.Object.Parent?.Name != "Person"),
            "a node table is under Graph Tables, and its hidden graph columns are left out as Object Explorer leaves them out");
        var servers = await FindIn(null, database, "names");
        check(servers.Hits.Any(hit => hit.Object is { Kind: "database", Database: null } && hit.Object.Name == database && hit.Folder == "databases"), "a database is found by name, under Databases");
        var sysadmin = (await FindIn(null, "sysadmin", "names", wholeWord: true)).Hits;
        check(sysadmin.Any(hit => hit.Object is { Kind: "serverRole", Database: null, Name: "sysadmin" } && hit.Folder == "serverRoles"), "a fixed server role is found under Security › Server Roles");
        check((await FindIn(null, "sa", "names", wholeWord: true)).Hits.Any(hit => hit.Object is { Kind: "login", Database: null, Name: "sa" } && hit.Folder == "logins" && hit.Subtype == "sa"),
            "the sa login is found under Security › Logins");
        check((await Find("sysadmin", "names", wholeWord: true)).Hits.All(hit => hit.Object.Database == database), "a search of one database leaves out the server's objects");
        var inDefinition = await Find(marker, "definitions");
        check(inDefinition.Hits.Count == 2 && inDefinition.Hits.Any(hit => hit.Label == "srch.usp_Find" && hit.Definition is { Line: 3 } && hit.Definition.Preview.Contains(marker, StringComparison.Ordinal)),
            "a definition search finds both modules that hold the marker, with the match's line");
        check((await Find(marker, "definitions", caseSensitive: true)).Hits is [{ Label: "srch.usp_Find" }], "Match Case leaves out the trigger's upper-case marker");
        check((await Find("varia_marker", "definitions", wholeWord: true)).Hits.Count == 0, "Whole Word does not match part of the marker");
        check((await Find(@"^\s*--\s*varia_marker_[0-9a-f]{8}$", "definitions", regex: true)).Hits.Any(hit => hit.Label == "srch.usp_Find"), "a regular expression matches a definition's line");
        check((await Find("(a", regex: true)).Problem is { Length: > 0 }, "an invalid regular expression answers why");

        await Build();
        // A rebuild swaps each database for its new read: the texts both hold stay pooled, and nothing is charged twice (tempdb's
        // objects may change meanwhile, so the memory is compared within a margin).
        check(service.Search.Resources.Sets == 1 && Math.Abs(service.Search.MemoryUsed - memoryBefore) < memoryBefore / 10,
            "a rebuild of an unchanged server reuses its system objects' set and holds about the memory the build before it held");
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

        // A budget the system objects alone fill: every database read stops at its first record, and the build still ends ready,
        // with the database skipped as TOO_LARGE. That the stopped read cancels its batch rather than draining it is the check
        // after this one, against the same server.
        using (var tight = new ObjectSearchService(service, new ObjectIndexLimits { MemoryBytes = 64 * 1024, NamesReserveBytes = 0 }))
        {
            var small = await tight.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), CancellationToken.None);
            check(small.Status.State == "ready" && small.Status.Skipped.Any(skip => skip.Database == database && skip.Code == "TOO_LARGE"),
                "a database past the memory budget stops its read, is skipped as TOO_LARGE, and the build ends ready (" + small.ElapsedMs + " ms)");
        }
        // A stopped index read cancels its batch on the server, through the same ReadBatchAsync every index read takes: a batch of
        // 40 MB of rows stopped at its first row never reaches the statement after them. Without the cancel (the control), closing
        // the reader drains every row and the statement runs, so the check bites. Neither depends on timing or load.
        check(!await RanToEnd(service, connectionId, cancel: true), "a stopped index read cancels its batch on a real server, so the rest of it is never sent");
        check(await RanToEnd(service, connectionId, cancel: false), "a reader closed short of its end without a cancel drains the batch on a real server");
        await sql("DROP TYPE [srch].[FindList]; DROP TABLE [srch].[" + hostile.Replace("]", "]]") + "]; DROP TABLE [srch].[Priced]; DROP PROCEDURE [srch].[usp_Param];"
            + " ALTER TABLE [srch].[Rates] SET (SYSTEM_VERSIONING = OFF); DROP TABLE [srch].[Rates]; DROP TABLE [srch].[Rates_Archive]; DROP TABLE [srch].[Person];"
            + " DROP USER [srch_user]; DROP ROLE [srch_role]; DROP SCHEMA [srch];", database);
    }

    /// <summary>Reads the first of many large rows on the index's pool and stops, cancelling the batch (as an index read does) or
    /// not; whether the statement after the rows then ran, which only a drained batch reaches.</summary>
    private static async Task<bool> RanToEnd(SqlService service, string connectionId, bool cancel)
    {
        var host = (IObjectSearchHost)service;
        await using var connection = host.Connection(connectionId, null);
        await host.OpenAsync(connection, CancellationToken.None);
        await using (var command = connection.CreateCommand())
        {
            command.CommandTimeout = 0;
            command.CommandText = "SELECT TOP (5000) CONVERT(nvarchar(4000), REPLICATE(N'x', 4000)) AS value FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b;"
                + " EXEC sys.sp_set_session_context N'varia_drained', 1;";
            Func<System.Data.Common.DbDataReader, Task<string?>> first = async rows => { await rows.ReadAsync(); return null; };
            if (cancel) await ObjectSearchService.ReadBatchAsync<string>(command, first, _ => { }, CancellationToken.None);
            else await ObjectSearchService.ReadThenStopAsync<string>(async () => await command.ExecuteReaderAsync(System.Data.CommandBehavior.SequentialAccess), first, () => { }, _ => { });
        }
        await using var probe = connection.CreateCommand();
        probe.CommandText = "SELECT CONVERT(int, SESSION_CONTEXT(N'varia_drained'));";
        return await probe.ExecuteScalarAsync() is int;
    }

}
