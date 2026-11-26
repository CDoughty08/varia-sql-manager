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
        created = await sql("CREATE TABLE [srch].[Line] (id int, priced_id int CONSTRAINT [fk_srch_line_priced] FOREIGN KEY REFERENCES [srch].[Priced] (id));", database);
        check(created.Error is null, "the search checks create a table with a foreign key: " + created.Error);
        created = await sql("CREATE PARTITION FUNCTION [srch_pf] (int) AS RANGE LEFT FOR VALUES (10); CREATE PARTITION SCHEME [srch_ps] AS PARTITION [srch_pf] ALL TO ([PRIMARY]);"
            + " CREATE TABLE [srch].[Parted] (a int, c int) ON [srch_ps] (c); CREATE INDEX [ix_srch_parted] ON [srch].[Parted] (a);", database);
        check(created.Error is null, "the search checks create a partitioned table with an aligned index: " + created.Error);
        // SQL Server 2025 and Azure SQL have vector columns; older servers refuse the table and the check after the build is skipped.
        var vectors = (await sql("CREATE TABLE [srch].[Vectors] (v vector(3));", database)).Error is null
            && (await sql("CREATE PROCEDURE [srch].[usp_Vector] @v vector(3) AS SELECT 1;", database)).Error is null;

        async Task<ObjectIndexResult> Build(bool definitions = true) => (ObjectIndexResult)await service.DispatchAsync("explorer.index",
            JsonSerializer.SerializeToElement(new ObjectIndexArgs(connectionId, Guid.NewGuid().ToString(), definitions), json), json);
        async Task<ObjectSearchResult> Find(string text, string scope = "all", bool caseSensitive = false, bool wholeWord = false, bool regex = false) =>
            await FindIn(database, text, scope, caseSensitive, wholeWord, regex);
        async Task<ObjectSearchResult> FindIn(string? inDatabase, string text, string scope = "all", bool caseSensitive = false, bool wholeWord = false, bool regex = false) =>
            (ObjectSearchResult)await service.DispatchAsync("explorer.search", JsonSerializer.SerializeToElement(
                new ObjectSearchArgs(connectionId, Guid.NewGuid().ToString(), text, caseSensitive, wholeWord, regex, scope, Database: inDatabase), json), json);

        // The saved index (IndexStore), on a temporary folder under a key of the checks' own: the first build saves what it reads.
        var storeRoot = Directory.CreateTempSubdirectory("varia-index-store-live-").FullName;
        var storeFolder = Path.Combine(storeRoot, IndexStoreLimits.FolderName);
        var storeKey = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        service.Search.Store.Configure(new("encrypted", storeFolder, IndexStoreLimits.DefaultDiskMiB, Convert.ToBase64String(storeKey)));
        await service.Search.Store.Idle();

        var events = new List<JsonElement>();
        var built = await service.Search.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), CancellationToken.None, value => events.Add(JsonSerializer.SerializeToElement(value, json)));
        try
        {
            // A real build's units, each saved under the scope the connection itself established, and each loading back equal.
            await service.Search.Store.Idle();
            var profile = ((IObjectSearchHost)service).Profile(connectionId);
            var scope = service.Search.ScopeOf(connectionId, profile);
            var index = service.Search.IndexOf(connectionId)!;
            var savedReads = index.Held.Where(read => !read.FailedPart).ToList();
            var listed = scope is null ? [] : service.Search.Store.List(scope);
            var files = Directory.GetFiles(storeFolder);
            check(scope is not null && profile.ServerName is { Length: > 0 } && profile.PrincipalId is { Length: > 0 },
                "the connect probe established the server's own name and the account, which is whose saved index this is");
            check(listed.Count == savedReads.Count && savedReads.Count >= 2 && files.Length == savedReads.Count + (index.Resource is null ? 0 : 1) && service.Search.Store.Counts.Failed == 0
                && files.All(file => IndexStoreNames.IsUnit(Path.GetFileName(file))) && service.Search.Store.Status is { Mode: "encrypted" } storeStatus && storeStatus.Files == files.Length,
                "a real build saves every unit it holds, and the shared system objects once (" + files.Length + " files, " + files.Sum(file => new FileInfo(file).Length) + " bytes for " + savedReads.Count + " reads)");
            var again = new IndexFileChecks.World(new ObjectIndexLimits { MemoryBytes = 4L << 30, NamesReserveBytes = 1L << 30 });
            var equal = true;
            foreach (var read in savedReads)
            {
                var kind = ReferenceEquals(read, index.Server) ? IndexUnitKind.Server : ReferenceEquals(read, index.Agent) ? IndexUnitKind.Agent : IndexUnitKind.Database;
                var unit = listed.SingleOrDefault(item => item.Kind == kind && item.Database == read.Database);
                if (unit is null) { equal = false; continue; }
                var loaded = service.Search.Store.Load(unit, again.Connection, again.Limits, again.Pool);
                equal &= loaded.Value is { } value && IndexFileChecks.Dump(value) == IndexFileChecks.Dump(read) && unit.Header.Children == !read.ChildrenLeftOut;
                if (loaded.Value is { } put) again.Connection.Abandon(put);
            }
            var resourceEqual = index.Resource is not { } set || service.Search.Store.LoadResource(set.Key, long.MaxValue).Value is { } savedSet && IndexFileChecks.Dump(savedSet.Read.Table) == IndexFileChecks.Dump(set.Table);
            check(equal && resourceEqual, "every unit the real build saved loads back equal to what the index holds");
            // Only needles of 8 bytes or more: ciphertext is random, so a shorter one turns up by chance (CI's login "sa" is 2 bytes
            // in UTF-8, one chance in 65,536 at every position of hundreds of KB). At 8 bytes a chance match is one in 2^64 a position.
            string[] texts = [hostile, marker, "usp_Find", "srch", database, profile.ServerName ?? "varia-no-server-name", profile.Login ?? "varia-no-login-name", "spt_fallback_db", "sp_who"];
            var distinctive = texts.Index()
                .SelectMany(text => new[] { (Label: text.Index + " UTF-8", Bytes: System.Text.Encoding.UTF8.GetBytes(text.Item)), (Label: text.Index + " UTF-16", Bytes: System.Text.Encoding.Unicode.GetBytes(text.Item)) })
                .Where(needle => needle.Bytes.Length >= 8).ToList();
            var inFiles = files.SelectMany(file => File.ReadAllBytes(file) is var content ? distinctive.Where(needle => content.AsSpan().IndexOf(needle.Bytes) >= 0).Select(needle => needle.Label) : []).Distinct().ToList();
            check(distinctive.Count >= 12 && inFiles.Count == 0,
                "no saved file holds an object's, the database's, the server's or the login's name, or a definition's text, in UTF-8 or UTF-16 ("
                + distinctive.Count + " needles; found: " + (inFiles.Count == 0 ? "none" : string.Join(", ", inFiles)) + ")");
            check((await service.Search.Store.ClearAsync()) is { Kept: 0 } cleared && cleared.Files == files.Length && Directory.GetFiles(storeFolder).Length == 0, "a clear deletes every file the build saved");
        }
        finally
        {
            // The rest of the suite builds without a store: nothing more is written.
            service.Search.Store.Configure(new("disabled", storeFolder, IndexStoreLimits.DefaultDiskMiB));
            await service.Search.Store.Idle();
            try { Directory.Delete(storeRoot, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
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
        // The Memory panel's index detail: a real build and search record their times, and the server's long modules show as packed.
        var memoryDetail = service.Search.MemoryDetail();
        check(memoryDetail is { Connections: >= 1, LastBuildMs: not null, LastSearchMs: not null, PackedTexts: > 0 } && memoryDetail.Objects >= built.Status.Objects
            && memoryDetail.ChildrenLeftOut == built.Status.Skipped.Count(skip => skip.Code == ObjectSearchService.ChildrenLeftOut)
            && memoryDetail.DefinitionTexts >= memoryDetail.PackedTexts && memoryDetail.PackedTextBytes > memoryDetail.PackedBytes,
            "the index detail carries the last build's and search's times and the server's packed definitions: " + memoryDetail);
        var memoryBefore = service.Search.MemoryUsed;

        // The editor metadata a build keeps beside the children, as a real server reports it: types with their lengths and flags,
        // a key's and an index's columns, a foreign key's column pairs and referenced table, a parameter's type, and the resource
        // database's typed parameters (sys.sp_who's @loginame is a sysname).
        static int At(ObjectTable table, string kind, string name, string? parent)
        {
            for (var at = 0; at < table.Count; at++)
                if (table.Kind(at) == kind && table.Name(at) == name && table.ParentName(at) == parent) return at;
            return -1;
        }
        var held = service.Search.IndexOf(connectionId);
        var mine = held?.Databases.SingleOrDefault(value => value.Database == database)?.Table;
        check(mine?.Details is not null, "a build keeps the scratch database's editor metadata");
        if (mine is not null)
        {
            TypedDetail? Typed(string name, string parent, string kind = "column") => At(mine, kind, name, parent) is var at and >= 0 ? mine.Typed(at) : null;
            check(Typed("id", "Priced") is { TypeText: "int", Ordinal: 1 } id && (id.Flags & TypedFlags.Nullable) == 0
                && Typed("price", "Priced") is { TypeText: "money" } price && (price.Flags & TypedFlags.Nullable) != 0
                && Typed("srch_total", "Priced") is { } total && (total.Flags & TypedFlags.Computed) != 0
                && Typed("note", "Priced") is { TypeText: "nvarchar(40)" } note && (note.Flags & TypedFlags.Default) != 0
                && Typed("valid_from", "Rates")?.TypeText == "datetime2(7)",
                "a real server's columns carry their types, lengths, ordinals and flags: " + string.Join(", ", new[] { "id", "price", "srch_total", "note" }.Select(name => name + " " + Typed(name, "Priced")?.TypeText)));
            check(!vectors || Typed("v", "Vectors")?.TypeText == "vector(3)" && Typed("@v", "usp_Vector", "parameter")?.TypeText == "vector(3)",
                "a real server's vector column and parameter read with their dimensions, not their bytes: " + Typed("v", "Vectors")?.TypeText + ", " + Typed("@v", "usp_Vector", "parameter")?.TypeText);
            check(Typed("@srch_param", "usp_Param", "parameter") is { TypeText: "int", Ordinal: 1 }, "a real server's parameter carries its type and ordinal");
            var priced = At(mine, "table", "Priced", null);
            var foreign = At(mine, "key", "fk_srch_line_priced", "Line");
            check(mine.KeyColumns(At(mine, "key", "pk_srch_priced", "Priced")) is [{ Column: 1 }] && mine.KeyColumns(At(mine, "index", "ix_srch_price", "Priced")) is [{ Column: 2, Flags: 0 }]
                && mine.KeyColumns(foreign) is [{ Column: 2, Referenced: 1 }] && priced >= 0 && mine.Referenced(foreign) == priced,
                "a real server's primary key, index and foreign key carry their columns, and the foreign key its referenced table");
            check(mine.KeyColumns(At(mine, "index", "ix_srch_parted", "Parted")) is [{ Column: 1, Flags: 0 }],
                "an aligned index on a partitioned table keeps only its own key, not the partitioning column SQL Server adds: "
                + string.Join(", ", mine.KeyColumns(At(mine, "index", "ix_srch_parted", "Parted")).Select(column => column.Column + ":" + column.Flags)));
        }
        var resource = held?.Resource?.Table;
        check(resource is not null && At(resource, "parameter", "@loginame", "sp_who") is var login and >= 0 && resource.Typed(login)?.TypeText == "sysname",
            "the resource database's parameters carry their types");

        // The editor's lookup on a real build: the scratch database is Latin1_General_100_CS_AS_SC, so its names tell case apart; a
        // table's columns, keys and indexes and a foreign key in both directions by name; a system view from the resource set.
        var lookup = service.Search.Lookup(connectionId);
        var found = lookup?.Objects(database, "srch", "Priced");
        check(found is { Database: { State: LookupState.Ready, CaseSensitive: true, ReadAt: not null }, Value: [{ Kind: "table" }] } && lookup!.Objects(database, "srch", "priced").Value.Count == 0
            && lookup.Objects(database, "SRCH", "Priced").Value.Count == 0,
            "a lookup in a case-sensitive database finds the exact name only: " + found?.Database);
        var master = lookup?.Database("master");
        check(master is { CaseSensitive: { } cased } && lookup!.Objects("master", "DBO", "SPT_FALLBACK_DB").Value.Count == (cased ? 0 : 1) && lookup.Objects("master", "dbo", "spt_fallback_db").Value.Count == 1,
            "master's lookups follow its own collation's case rule: " + master);
        if (found?.Value is [var pricedTable] && lookup is not null)
        {
            check(lookup.Columns(pricedTable).Select(column => column.Name).SequenceEqual(["id", "price", "srch_total", "note"]) && lookup.Columns(pricedTable)[3].Type?.TypeText == "nvarchar(40)",
                "a real table's columns come by column_id with their types: " + string.Join(", ", lookup.Columns(pricedTable).Select(column => column.Name)));
            var indexes = lookup.Indexes(pricedTable);
            check(indexes.Any(value => value is { Kind: "key", Subtype: "primary", Entry.Name: "pk_srch_priced", Columns: [{ Name: "id" }] })
                && indexes.Any(value => value is { Kind: "index", Entry.Name: "ix_srch_price", Columns: [{ Name: "price", Descending: false, Included: false }] }),
                "a real table's primary key and index come with their columns by name: " + string.Join(", ", indexes.Select(value => value.Kind + " " + value.Entry.Name)));
            check(lookup.ReferencedBy(pricedTable) is [{ Entry.Name: "fk_srch_line_priced", Table.Name: "Line", Pairs: [("priced_id", "id")] }]
                && lookup.Objects(database, "srch", "Line").Value is [var line] && lookup.ForeignKeys(line) is [{ Referenced: { Name: "Priced" }, Pairs: [("priced_id", "id")] }],
                "a real foreign key is found from both its tables, with its columns by name");
            check(lookup.Objects(database, "sys", "objects").Value is [{ Kind: "view", Source: null } objects] && lookup.Columns(objects).Any(column => column is { Name: "object_id", Type.TypeText: "int" }),
                "a system view is found from the resource set in the scratch database, with its typed columns");
        }

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
            var ended = service.Search.Builds;
            var running = service.Search.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), stop.Token);
            stop.Cancel();
            var cancelled = false;
            try { await running; check(true, "Stop ends a build (it had finished)"); }
            catch (RequestException error) { cancelled = error.Code == "CANCELLED"; check(cancelled, "Stop ends a build with CANCELLED"); }
            // Stopped or finished, the build's end tells the memory report to walk again (no read left showing as running).
            check(service.Search.Builds >= ended + 1, "a stopped build counts as ended for the memory report");
            check((await Find("FindList", "names")).Hits.Count == 1, "a stopped build keeps the index it had");
            // explorer.indexStatus, through dispatch, tells the window what the stopped build kept: ready, and stopped.
            async Task<ObjectIndexStatus> IndexStatus() =>
                ((ObjectIndexResult)await service.DispatchAsync("explorer.indexStatus", JsonSerializer.SerializeToElement(new ObjectIndexStatusArgs(connectionId), json), json)).Status;
            var afterStop = await IndexStatus();
            check(afterStop.State == "ready" && afterStop.Stopped == (cancelled ? true : null), $"explorer.indexStatus reports a stopped build's index as ready and stopped ({afterStop.State}, {afterStop.Stopped}, cancelled {cancelled})");
            await Build();
            check((await IndexStatus()).Stopped is null, "a finished build clears the stopped mark");
        }

        // A budget the system objects alone fill: every database read stops at its first record, and the build still ends ready,
        // with the database skipped as TOO_LARGE. That the stopped read cancels its batch rather than draining it is the check
        // after this one, against the same server.
        using (var tight = new ObjectSearchService(service, new ObjectIndexLimits { MemoryBytes = 64 * 1024, NamesReserveBytes = 0 }))
        {
            // The editor's lookup follows the service's builds: building once listed, skipped with the build's reason after.
            LookupDatabase? during = null;
            var small = await tight.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), CancellationToken.None, _ => during ??= tight.Lookup(connectionId)?.Database(database));
            check(small.Status.State == "ready" && small.Status.Skipped.Any(skip => skip.Database == database && skip.Code == "TOO_LARGE"),
                "a database past the memory budget stops its read, is skipped as TOO_LARGE, and the build ends ready (" + small.ElapsedMs + " ms)");
            check(during is { State: LookupState.Building, Held: null } && tight.Lookup(connectionId)?.Database(database) is { State: LookupState.Skipped, Skip.Code: "TOO_LARGE" },
                "a lookup during a real build sees a listed database as building, and after it as skipped with its reason: " + during + " then " + tight.Lookup(connectionId)?.Database(database));
            // A build stopped once it has listed the databases leaves each one it did not reach as its last read left it.
            using var stop = new CancellationTokenSource();
            LookupDatabase? stopping = null;
            var stopped = false;
            try
            {
                await tight.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), stop.Token, _ =>
                {
                    stopping ??= tight.Lookup(connectionId)?.Database(database);
                    stop.Cancel();
                });
            }
            catch (RequestException error) when (error.Code == "CANCELLED") { stopped = true; }
            check(stopped && stopping is { State: LookupState.Building, Skip.Code: "TOO_LARGE" } && tight.Lookup(connectionId)?.Database(database) is { State: LookupState.Skipped, Skip.Code: "TOO_LARGE" },
                "a stopped real build leaves a database it did not reach skipped as before, never absent or ready: " + stopping + " then " + tight.Lookup(connectionId)?.Database(database));
        }
        // Another connection's BigQuery index holding everything its floors allow, the most BigQuery can take of the budget, under
        // a limit this build's own request raises to 1,024 MiB (so the 640 MiB held is over the limit until the build applies
        // it): this server's definitions still fit, none is left out for memory, and a search inside them finds this run's
        // marker. (A server whose index needs more than the 128 MiB that leaves above the names' reserve would fail this.)
        using (var beside = new ObjectSearchService(service))
        {
            const long MiB = 1024 * 1024;
            beside.Budget.Force(1024 * MiB - 1024 * MiB / 8 * 3);
            var full = await beside.IndexAsync(new(connectionId, Guid.NewGuid().ToString(), MemoryLimitMiB: 1024), CancellationToken.None);
            var inside = beside.Search(new ObjectSearchArgs(connectionId, Guid.NewGuid().ToString(), marker, In: "definitions", Database: database), CancellationToken.None);
            check(beside.Budget.Limit == 1024 * MiB && beside.Limits is { NamesReserveBytes: 256 * MiB, BigQueryNamesFloorBytes: 384 * MiB },
                "a SQL Server build's memory limit reaches the budget on a real connection, with the reserve and floors in proportion");
            check(full.Status is { State: "ready", LeftOut: null, LeftOutIn: null, Modules: > 0 } && full.Status.Skipped.All(skip => skip.Code is not ("TOO_LARGE" or ObjectSearchService.ChildrenLeftOut))
                && inside.Total >= 1 && beside.Budget.Free >= beside.Limits.NamesReserveBytes,
                $"beside a BigQuery index at its floor a real server keeps its definitions ({full.Status.Modules} kept, {full.Status.LeftOut ?? 0} left out, {inside.Total} hits inside them, {beside.Budget.Free / MiB} MiB free)");
        }
        // Memory that ran out and came back: built with less than the names' reserve free, every definition is left out, the
        // shared system objects' too, and the status says so; once there is room, a rebuild reads them all, the system objects
        // again as well, and the count goes.
        using (var starved = new ObjectSearchService(service))
        {
            var others = starved.Limits.MemoryBytes - starved.Limits.NamesReserveBytes + 1;
            starved.Budget.Force(others);
            var without = await starved.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), CancellationToken.None);
            var system = starved.IndexOf(connectionId)?.Resource?.LeftOut ?? -1;
            starved.Budget.Release(others);
            var with = await starved.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), CancellationToken.None);
            check(without.Status is { LeftOut: > 0, LeftOutIn: > 0 } && system > 0 && with.Status is { LeftOut: null, LeftOutIn: null } && with.Status.Modules > without.Status.Modules
                && starved.IndexOf(connectionId)?.Resource is { LeftOut: 0, Modules: > 0 } && starved.Resources.Held.Count == 1,
                $"definitions left out for memory are counted ({without.Status.LeftOut} in {without.Status.LeftOutIn} databases, {system} of the system objects) and all read once a rebuild finds room ({with.Status.Modules} kept)");
        }
        // A stopped index read cancels its batch on the server, through the same ReadBatchAsync every index read takes: a batch of
        // 40 MB of rows stopped at its first row never reaches the statement after them. Without the cancel (the control), closing
        // the reader drains every row and the statement runs, so the check bites. Neither depends on timing or load.
        check(!await RanToEnd(service, connectionId, cancel: true), "a stopped index read cancels its batch on a real server, so the rest of it is never sent");
        check(await RanToEnd(service, connectionId, cancel: false), "a reader closed short of its end without a cancel drains the batch on a real server");
        await sql("DROP TYPE [srch].[FindList]; DROP TABLE [srch].[" + hostile.Replace("]", "]]") + "]; DROP TABLE [srch].[Line]; DROP TABLE [srch].[Priced]; DROP TABLE [srch].[Parted]; DROP TABLE IF EXISTS [srch].[Vectors]; DROP PROCEDURE IF EXISTS [srch].[usp_Vector]; DROP PROCEDURE [srch].[usp_Param];"
            + " ALTER TABLE [srch].[Rates] SET (SYSTEM_VERSIONING = OFF); DROP TABLE [srch].[Rates]; DROP TABLE [srch].[Rates_Archive]; DROP TABLE [srch].[Person];"
            + " DROP USER [srch_user]; DROP ROLE [srch_role]; DROP SCHEMA [srch]; DROP PARTITION SCHEME [srch_ps]; DROP PARTITION FUNCTION [srch_pf];", database);
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
