using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>
/// The budget's shares (docs/object-search.md, Memory): BigQuery's reads keep floors of the budget free, so a SQL Server
/// database still keeps its definitions however much BigQuery metadata is indexed, in either build order and across rebuilds;
/// BigQuery gives up discovered projects' details first; and the limit a build carries applies from then on.
/// </summary>
internal static partial class BigQueryIndexChecks
{
    /// <summary>A small budget with production's proportions: a quarter is the names' reserve, and BigQuery's floors follow from it.</summary>
    static ObjectIndexLimits ShareLimits() => new() { MemoryBytes = 400_000, NamesReserveBytes = 100_000 };

    /// <summary>More BigQuery than the budget holds: four starred projects whose details fit under their floor whatever order they are
    /// read in, leaving less room above the discovered projects' floor than one discovered project's details take.</summary>
    static FakeBudgetSource ShareSource() => new(discoveredProjects: [.. Enumerable.Range(0, 24).Select(at => "disc-" + at.ToString("D2", System.Globalization.CultureInfo.InvariantCulture))],
        tablesPerDiscovered: 1, columnsPerTable: 300);

    static readonly List<string> ShareStarred = ["star-01", "star-02", "star-03", "star-04"];
    static readonly ObjectIndexStatus ShareReady = new("ready", 1, 1, 0, 0, 0, [], true);

    /// <summary>A SQL Server database's read under the service's budget, as a build's read charges it: its definitions come last.</summary>
    static Task<DatabaseIndex?> SqlRead(ObjectSearchService search, string database, int procedures, DatabaseIndex? replaces = null) =>
        new DatabaseReader(database, search.Limits, search.Pool, replaces).ReadAsync(SearchCostChecks.Procedures(procedures), true, CancellationToken.None, children: false);

    static int DefinitionHits(ConnectionIndex index, ObjectSearchService search, string text) =>
        IndexSearch.Run(index, new(text, false, false, false, false, true, null, null, 200), SearchMatcher.Create(text, false, false, false, TimeSpan.FromSeconds(2)).Matcher!,
            search.Limits, ShareReady, CancellationToken.None).Total;

    static async Task SharesAsync(Action<bool, string> check)
    {
        // 1. BigQuery first: it fills what it may, then a SQL Server connection is indexed.
        {
            var limits = ShareLimits();
            var source = ShareSource();
            using var search = new ObjectSearchService(new UnusedHost(), limits);
            var bigQuery = Guid.NewGuid().ToString();
            var built = await search.IndexBigQueryAsync(new ObjectIndexArgs(bigQuery, Guid.NewGuid().ToString(), StarredProjects: ShareStarred), source, CancellationToken.None);
            var held = search.HeldOf(bigQuery);
            var starred = held.Where(read => read.Database.StartsWith("star-", StringComparison.Ordinal)).ToList();
            var discovered = held.Where(read => read.Database.StartsWith("disc-", StringComparison.Ordinal)).ToList();
            var detailed = discovered.Count(read => read.Table.Count > 2);
            var free = search.Budget.Free;
            check(starred.Count == 4 && starred.All(read => !read.ChildrenLeftOut && read.Table.Count == 302) && discovered.Count == 24 && detailed == 0
                && built.Status.NamesOnly is { Count: 24 } namesOnly && namesOnly.All(project => project.StartsWith("disc-", StringComparison.Ordinal)),
                $"BigQuery gives up discovered projects' details first: every starred project keeps its columns, {detailed} of 24 discovered projects do, and those are reported as names only ({built.Status.NamesOnly?.Count})");
            // One discovered project's details take more than what is left above the discovered floor, which is why none was kept.
            var oneProject = starred[0].Bytes - discovered[0].Bytes;
            check(free >= limits.BigQueryDetailsFloorBytes && free - limits.BigQueryDiscoveredFloorBytes < oneProject,
                $"BigQuery fills the budget only down to its floors: {free} bytes free of {limits.MemoryBytes}, {free - limits.BigQueryDiscoveredFloorBytes} above the discovered floor where a project's columns take {oneProject}");
            // The bug this guards against: with less than the names' reserve free, this read kept names only.
            var sql = Guid.NewGuid().ToString();
            var sales = await SqlRead(search, "Sales", 60);
            search.Held(sql).Put(sales!);
            check(sales is { Modules: 60, Cut: 0, LeftOut: 0 } && DefinitionHits(search.Held(sql), search, "dbo.p7 AS SELECT 7") == 1,
                $"a SQL Server database indexed after a full BigQuery index keeps its definitions, and a search inside them finds one ({sales?.Modules} kept, {sales?.LeftOut} left out)");
            // A BigQuery rebuild takes no more than it held, and the SQL Server rebuild after it (changed and new modules) still fits.
            var rebuilt = await search.IndexBigQueryAsync(new ObjectIndexArgs(bigQuery, Guid.NewGuid().ToString(), StarredProjects: ShareStarred), source, CancellationToken.None);
            var again = await SqlRead(search, "Sales", 90, sales);
            search.Held(sql).Put(again!);
            var other = await SqlRead(search, "Archive", 60);
            search.Held(sql).Put(other!);
            check(rebuilt.Status.State == "ready" && search.Budget.Free >= limits.NamesReserveBytes && again is { Modules: 90, LeftOut: 0 } && other is { Modules: 60, LeftOut: 0 }
                && DefinitionHits(search.Held(sql), search, "dbo.p88 AS SELECT 88") == 1,
                $"after BigQuery rebuilds, a SQL Server rebuild with new modules and a second database keep their definitions ({again?.Modules}, {other?.Modules}; {search.Budget.Free} bytes free)");
            // SQL Server has since taken memory below BigQuery's details floor. A dataset that is read again, by a Refresh of its
            // project, then by a full rebuild, keeps the columns it held: pass 1 goes on holding them until pass 2 has read them
            // again, rather than give their memory back and be refused it above the floor.
            var taken = search.Budget.Free - limits.BigQueryDetailsFloorBytes + 2_000;
            search.Budget.Force(taken);
            var refreshed = await search.IndexBigQueryAsync(new ObjectIndexArgs(bigQuery, Guid.NewGuid().ToString(), StarredProjects: ShareStarred, Scope: new("star-01")), source, CancellationToken.None);
            var afterRefresh = search.HeldOf(bigQuery).Single(read => read.Database == "star-01");
            var whole = await search.IndexBigQueryAsync(new ObjectIndexArgs(bigQuery, Guid.NewGuid().ToString(), StarredProjects: ShareStarred), source, CancellationToken.None);
            var afterRebuild = search.HeldOf(bigQuery).Where(read => read.Database.StartsWith("star-", StringComparison.Ordinal)).ToList();
            check(search.Budget.Free < limits.BigQueryDetailsFloorBytes && afterRefresh is { ChildrenLeftOut: false, Table.Count: 302 }
                && refreshed.Status.Skipped.All(skip => skip.Project != "star-01") && afterRebuild.Count == 4 && afterRebuild.All(read => read is { ChildrenLeftOut: false, Table.Count: 302 })
                && whole.Status.Skipped.All(skip => skip.Code != ObjectSearchService.ChildrenLeftOut),
                $"below its details floor a BigQuery dataset read again by a Refresh or a rebuild keeps the columns it held ({afterRefresh.Table.Count} entries after the Refresh, {search.Budget.Free} bytes free)");
            DatabaseIndex Starred(string project) => search.HeldOf(bigQuery).Single(read => read.Database == project);
            Task<ObjectIndexResult> Rebuild() => search.IndexBigQueryAsync(new ObjectIndexArgs(bigQuery, Guid.NewGuid().ToString(), StarredProjects: ShareStarred), source, CancellationToken.None);
            // A table created again with the same columns (CREATE OR REPLACE) is not reused, yet is carried by name until pass 2
            // has read it: it costs nothing new, and is whole again afterwards.
            var created = new Dictionary<string, long> { ["star-03"] = 1_800_000_000_000 };
            source.CreatedOf = project => created.TryGetValue(project, out var at) ? at : null;
            var calls = source.DiscoveredDetailCalls;
            await Rebuild();
            check(Starred("star-03") is { ChildrenLeftOut: false, Table.Count: 302 } replaced && BigQueryEntries.Known(replaced, true).Count == 1 && source.DiscoveredDetailCalls == calls + 1
                && search.Budget.Free < limits.BigQueryDetailsFloorBytes,
                $"below its details floor a table created again is read again and keeps its columns ({Starred("star-03").Table.Count} entries, {source.DiscoveredDetailCalls - calls} detail read)");
            // What a dataset holds may grow a little, into the step between its details floor and the next one down.
            created["star-04"] = 1_900_000_000_000;
            source.ColumnsPerTable = 305;
            await Rebuild();
            check(Starred("star-04") is { ChildrenLeftOut: false, Table.Count: 307 } && search.Budget.Free >= limits.BigQueryNamesFloorBytes,
                $"a dataset that holds columns keeps them when a table gains a few, though less than its details floor is free ({Starred("star-04").Table.Count} entries, {search.Budget.Free} bytes free)");
            // A new table whose columns do not fit even there: the dataset keeps every column it held and the new table's name, and
            // says the new object's details are missing. Before, its name alone pushed the held columns out of the replaced read's
            // share, and the whole dataset fell back to names only.
            var squeeze = search.Budget.Free - limits.BigQueryNamesFloorBytes - 5_000;
            search.Budget.Force(squeeze);
            source.TablesPerDataset = new() { [("star-01", "ds")] = 2 };
            var grown = await Rebuild();
            var afterGrowth = Starred("star-01");
            check(afterGrowth is { ChildrenLeftOut: false, Table.Count: 303 } && grown.Status.Skipped.Count(skip => skip is { Project: "star-01", Database: "ds", Code: "TOO_LARGE", Details: true }) == 1
                && grown.Status.Skipped.All(skip => skip.Code != ObjectSearchService.ChildrenLeftOut) && search.HeldOf(bigQuery).Where(read => read.Database is "star-02" or "star-03").All(read => read.Table.Count == 302),
                $"a new table whose columns do not fit leaves the dataset the columns it held, its own left out as details missing ({afterGrowth.Table.Count} entries, {grown.Status.Skipped.Count} skips)");
            search.Budget.Release(squeeze);
            var roomy = await Rebuild();
            // The dataset, the table held (300 columns, reused) and the new one (305).
            check(Starred("star-01") is { ChildrenLeftOut: false, Table.Count: 1 + 301 + 306 } && roomy.Status.Skipped.All(skip => skip.Project != "star-01"),
                $"with room the next build reads the new table's columns and the skip goes ({Starred("star-01").Table.Count} entries)");
            // A Refresh whose detail read fails keeps nothing a later build would take for whole: the table is read again.
            source.FailTableForProject = "star-02";
            var failing = await search.IndexBigQueryAsync(new ObjectIndexArgs(bigQuery, Guid.NewGuid().ToString(), StarredProjects: ShareStarred, Scope: new("star-02")), source, CancellationToken.None);
            var afterFailure = Starred("star-02");
            source.FailTableForProject = null;
            calls = source.DiscoveredDetailCalls;
            await Rebuild();
            // The table keeps the columns it held through the failed read, so the next build needs no room above the floor for them.
            check(BigQueryEntries.Known(afterFailure, true).Count == 0 && afterFailure is { ChildrenLeftOut: false, Table.Count: 302 }
                && failing.Status.Skipped.Any(skip => skip is { Project: "star-02", Details: true })
                && Starred("star-02") is { ChildrenLeftOut: false, Table.Count: 307 } healed && BigQueryEntries.Known(healed, true).Count == 1 && source.DiscoveredDetailCalls == calls + 1
                && search.Budget.Free < limits.BigQueryDetailsFloorBytes,
                $"a Refresh whose detail read failed keeps the table's columns but nothing reusable, so the next build reads it again ({afterFailure.Table.Count} then {Starred("star-02").Table.Count} entries, {source.DiscoveredDetailCalls - calls} detail read)");
            // No room at all above the names floor, and a new table whose name the pool already holds (the same name in a sibling
            // dataset), so its record is charged to the replaced read's share: the dataset is kept as it was read before, columns
            // and all, rather than swapped for a read without them. With room, the next build lists the table with its columns.
            var none = search.Budget.Free - limits.BigQueryNamesFloorBytes + 1_000;
            search.Budget.Force(none);
            var sibling = search.Pool.TryAcquire("star-03_tbl_1");
            source.TablesPerDataset = new() { [("star-01", "ds")] = 2, [("star-03", "ds")] = 2 };
            var full = await Rebuild();
            var keptAsWas = Starred("star-03");
            check(search.Budget.Free < limits.BigQueryNamesFloorBytes && keptAsWas is { ChildrenLeftOut: false, Table.Count: 302 }
                && full.Status.Skipped.Count(skip => skip is { Project: "star-03", Database: "ds", Code: "TOO_LARGE", Details: null }) == 1
                && full.Status.Skipped.All(skip => skip.Code != ObjectSearchService.ChildrenLeftOut) && full.Status.Skipped.All(skip => skip is not { Project: "", Database: "" })
                && search.HeldOf(bigQuery).Where(read => read.Database.StartsWith("star-", StringComparison.Ordinal)).All(read => !read.ChildrenLeftOut && read.Table.Count >= 302),
                $"with nothing free above the names floor a dataset that gains a table is kept as it was, columns and all ({keptAsWas.Table.Count} entries, {full.Status.Skipped.Count} skips)");
            search.Budget.Release(none + taken);
            search.Pool.Release([sibling]);
            var listed = await Rebuild();
            check(Starred("star-03") is { ChildrenLeftOut: false, Table.Count: 1 + 301 + 306 } && listed.Status.Skipped.All(skip => skip.Project != "star-03"),
                $"with room the next build lists the new table with its columns ({Starred("star-03").Table.Count} entries)");
            // Its lookup arrays are BigQuery's too: at the names floor they are not built and the lookup scans; with room, they are.
            var wide = search.HeldOf(bigQuery).Single(read => read.Database == "star-01");
            var spare = search.Budget.Free - limits.BigQueryNamesFloorBytes;
            search.Budget.Force(spare);
            var lookup = search.LookupBigQuery(bigQuery, "varia-alpha");
            var scanned = lookup.Object(lookup.Dataset("star-01", "ds"), "star-01_tbl_0") is not null && wide.LookupBuilds == 0;
            // What was forced goes back, and room for the arrays above the floor with it.
            search.Budget.Release(spare + TableLookup.BytesFor(wide.Table));
            lookup = search.LookupBigQuery(bigQuery, "varia-alpha");
            check(scanned && lookup.Object(lookup.Dataset("star-01", "ds"), "star-01_tbl_0") is not null && wide.LookupBuilds == 1,
                $"a BigQuery lookup array that would pass the names floor is not built (the lookup answers by scanning), and is built once there is room (scanned {scanned}, {wide.LookupBuilds} built, {TableLookup.BytesFor(wide.Table)} bytes of arrays, {spare} spare)");
        }

        // Discovered datasets that already hold details are read again whatever is free: below the discovered floor, and in a
        // build whose names pass stopped for memory. Their changed objects cost only what has grown.
        {
            var limits = ShareLimits();
            var projects = new List<string> { "disc-01", "disc-02", "disc-03" };
            var source = new FakeBudgetSource(projects, tablesPerDiscovered: 1, columnsPerTable: 20);
            using var search = new ObjectSearchService(new UnusedHost(), limits);
            var id = Guid.NewGuid().ToString();
            Task<ObjectIndexResult> Build() => search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            DatabaseIndex Held(string project) => search.HeldOf(id).Single(read => read.Database == project);
            var first = await Build();
            var allDetailed = first.Status.NamesOnly is null && projects.All(project => Held(project) is { Detailed: true, Table.Count: 22 });
            search.Budget.Force(search.Budget.Free - limits.BigQueryDiscoveredFloorBytes + 1_000);
            var created = new Dictionary<string, long> { ["disc-01"] = 1_800_000_000_000 };
            source.CreatedOf = project => created.TryGetValue(project, out var at) ? at : null;
            source.ColumnsPerTable = 22;
            var calls = source.DiscoveredDetailCalls;
            var below = await Build();
            check(allDetailed && search.Budget.Free < limits.BigQueryDiscoveredFloorBytes && Held("disc-01") is { Detailed: true, Table.Count: 24 } wider
                && BigQueryEntries.Known(wider, true).Count == 1 && below.Status.NamesOnly is null && source.DiscoveredDetailCalls == calls + 1,
                $"below the discovered floor a discovered dataset that holds details has its changed table read again ({Held("disc-01").Table.Count} entries, {source.DiscoveredDetailCalls - calls} detail read, names only: {below.Status.NamesOnly?.Count ?? 0})");
            // A new project whose names do not fit stops the names pass for memory; disc-02's table, created again meanwhile, is
            // still read. The new project's listing waits until disc-02's names are held, so the stop cannot cut that read off.
            search.Budget.Force(search.Budget.Free - limits.BigQueryNamesFloorBytes - 60);
            created["disc-02"] = 1_900_000_000_000;
            source.ColumnsPerTable = 20;
            projects.Add("disc-zz");
            // Bounded, so a build that never holds disc-02's names fails the check below rather than hang the suite.
            var names02 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            search.NamesHeld = (project, _) => { if (project == "disc-02") names02.TrySetResult(); };
            source.OnDatasetObjectsAsync = async (project, _, token) =>
            {
                if (project == "disc-zz") await names02.Task.WaitAsync(TimeSpan.FromSeconds(60), token);
            };
            calls = source.DiscoveredDetailCalls;
            var tight = await Build();
            source.OnDatasetObjectsAsync = null;
            search.NamesHeld = null;
            check(tight.Status.Skipped.Any(skip => skip is { Project: "", Database: "", Code: "TOO_LARGE" }) && search.HeldOf(id).All(read => read.Database != "disc-zz")
                && Held("disc-02") is { Detailed: true, Table.Count: 22 } again && BigQueryEntries.Known(again, true).Count == 1 && source.DiscoveredDetailCalls == calls + 1,
                $"a build whose names pass stopped for memory still reads a held dataset's changed table again ({source.DiscoveredDetailCalls - calls} detail read, {BigQueryEntries.Known(Held("disc-02"), true).Count} whole)");
        }

        // Below the details floor still: a date-sharded group whose newest shard (and so its entry's name) changes, a new table
        // beside names the dataset already holds, and a table created again whose read fails.
        {
            var limits = ShareLimits();
            var source = new FakeBudgetSource([], tablesPerDiscovered: 2, columnsPerTable: 20) { ShardDays = new() { [("star-01", "ds")] = 2 } };
            using var search = new ObjectSearchService(new UnusedHost(), limits);
            var id = Guid.NewGuid().ToString();
            List<string> starred = ["star-01", "star-02"];
            Task<ObjectIndexResult> Build() => search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), StarredProjects: starred), source, CancellationToken.None);
            DatabaseIndex Held(string project) => search.HeldOf(id).Single(read => read.Database == project);
            await Build();
            var group = Held("star-01");
            var grouped = group is { Detailed: true, Table.Count: 22 } && group.Facts!.Shards(1) is { Prefix: "events_", Count: 2 } && Held("star-02") is { Detailed: true, Table.Count: 43 };
            search.Budget.Force(search.Budget.Free - limits.BigQueryDetailsFloorBytes + 2_000);
            source.ShardDays[("star-01", "ds")] = 3;
            var calls = source.DiscoveredDetailCalls;
            var shard = await Build();
            check(grouped && Held("star-01") is { ChildrenLeftOut: false, Detailed: true, Table.Count: 22 } next && next.Facts!.Shards(1) is { Count: 3, Last: "20261103" }
                && BigQueryEntries.Known(next, true).Count == 1 && source.DiscoveredDetailCalls == calls + 1 && shard.Status.Skipped.Count == 0 && search.Budget.Free < limits.BigQueryDetailsFloorBytes,
                $"below its details floor a date-sharded group keeps its columns when a new shard renames its entry ({Held("star-01").Table.Count} entries, {shard.Status.Skipped.Count} skips)");
            // Room above the names floor for one new table's name, not for that and the names the dataset already holds again:
            // those are charged to the names' part of the read they replace, so the new table is listed (its columns, which do
            // not fit, reported as details missing) rather than the dataset kept as it was.
            search.Budget.Force(search.Budget.Free - limits.BigQueryNamesFloorBytes - 400);
            source.TablesPerDataset = new() { [("star-02", "ds")] = 3 };
            var named = await Build();
            check(Held("star-02") is { ChildrenLeftOut: false, Table.Count: 44 } && named.Status.Skipped.Count(skip => skip is { Project: "star-02", Code: "TOO_LARGE", Details: true }) == 1
                && named.Status.Skipped.Count == 1,
                $"with room for one name above the names floor a new table is listed beside the names its dataset holds ({Held("star-02").Table.Count} entries, {named.Status.Skipped.Count} skips)");
            // Pass 2 with nothing free: one table was created again with fewer columns, and another gained columns whose names
            // need room there is none of. Only the table that does not fit is left out: it keeps the columns it held, to be read
            // again, while the first table's new columns replace the earlier generation's, which never show as the new table's.
            search.Budget.Force(search.Budget.Free - limits.BigQueryNamesFloorBytes + 500);
            source.TablesPerDataset = new() { [("star-02", "ds")] = 2 };
            await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), StarredProjects: starred, Scope: new("star-02")), source, CancellationToken.None);
            var two = Held("star-02") is { Detailed: true, Table.Count: 43 } pair && BigQueryEntries.Known(pair, true).Count == 2 && search.Budget.Free < limits.BigQueryNamesFloorBytes;
            source.CreatedOfTable = (_, table) => table == "star-02_tbl_0" ? 1_750_000_000_000 : null;
            source.ColumnsOfTable = (_, table) => table == "star-02_tbl_0" ? 10 : table == "star-02_tbl_1" ? 25 : null;
            var nothing = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), StarredProjects: starred, Scope: new("star-02")), source, CancellationToken.None);
            var asItWas = Held("star-02");
            var facts = asItWas.Facts!;
            check(two && asItWas is { Detailed: true, ChildrenLeftOut: false, Table.Count: 1 + 11 + 21 }
                && Enumerable.Range(0, asItWas.Table.Count).Count(at => asItWas.Table.Parent(at) < 0 && facts.Of(at) is { Detailed: true }) == 2
                && BigQueryEntries.Known(asItWas, true).Keys.SequenceEqual([("bqTable", "star-02_tbl_0")])
                && nothing.Status.Skipped.Count(skip => skip is { Project: "star-02", Database: "ds", Code: "TOO_LARGE", Details: true }) == 1 && nothing.Status.Skipped.Count == 1,
                $"when one table's new details do not fit, only that table goes back to what was held: the others keep what pass 2 read ({asItWas.Table.Count} entries, {nothing.Status.Skipped.Count} skip)");
            source.CreatedOfTable = null;
            source.ColumnsOfTable = null;
            // The tables are created again and cannot be read: the columns carried from their earlier generation are not kept as
            // if they were the new tables'.
            source.CreatedOf = project => project == "star-02" ? 1_800_000_000_000 : null;
            source.FailTableForProject = "star-02";
            var failed = await Build();
            check(Held("star-02") is { Table.Count: 3, Detailed: false } && Held("star-01") is { Table.Count: 22 } && failed.Status.Skipped.Any(skip => skip is { Project: "star-02", Details: true }),
                $"a table created again whose read fails keeps none of its earlier generation's columns ({Held("star-02").Table.Count} entries)");
            // A date-sharded group is the same table whatever its newest shard: when its read fails on the day a shard is added,
            // it keeps the columns it held, to be read again.
            source.FailTableForProject = "star-01";
            source.ShardDays[("star-01", "ds")] = 4;
            var shardFailed = await Build();
            check(Held("star-01") is { ChildrenLeftOut: false, Detailed: true, Table.Count: 22 } kept4 && kept4.Facts!.Shards(1) is { Count: 4 } && BigQueryEntries.Known(kept4, true).Count == 0
                && shardFailed.Status.Skipped.Any(skip => skip is { Project: "star-01", Details: true }),
                $"a date-sharded group whose read fails on the day a shard is added keeps its columns ({Held("star-01").Table.Count} entries)");
        }

        // 2. SQL Server first, then BigQuery, then a SQL Server rebuild while BigQuery holds its share.
        {
            var limits = ShareLimits();
            using var search = new ObjectSearchService(new UnusedHost(), limits);
            var sql = Guid.NewGuid().ToString();
            var sales = await SqlRead(search, "Sales", 60);
            search.Held(sql).Put(sales!);
            var before = search.Budget.Used;
            var bigQuery = Guid.NewGuid().ToString();
            var built = await search.IndexBigQueryAsync(new ObjectIndexArgs(bigQuery, Guid.NewGuid().ToString(), StarredProjects: ShareStarred), ShareSource(), CancellationToken.None);
            var free = search.Budget.Free;
            check(built.Status.NamesOnly is { Count: 24 } && free >= limits.BigQueryDetailsFloorBytes && search.HeldOf(bigQuery).Count == 29
                && search.HeldOf(bigQuery).Where(read => read.Database.StartsWith("star-", StringComparison.Ordinal)).All(read => read.Table.Count == 302),
                $"with SQL Server indexed first ({before} bytes), BigQuery still stops at its floors: {free} bytes free, every dataset's names held ({search.HeldOf(bigQuery).Count})");
            var again = await SqlRead(search, "Sales", 90, sales);
            search.Held(sql).Put(again!);
            var other = await SqlRead(search, "Archive", 60);
            search.Held(sql).Put(other!);
            check(again is { Modules: 90, Cut: 0, LeftOut: 0 } && other is { Modules: 60, LeftOut: 0 } && DefinitionHits(search.Held(sql), search, "dbo.p7 AS SELECT 7") == 2,
                $"a SQL Server rebuild while BigQuery holds its share keeps every definition, new modules and a second database included ({again?.Modules}, {other?.Modules})");
        }

        // The floors themselves, one read at a time: with room above the names floor only, a dataset is kept without its columns;
        // below the names floor it is refused, and gives back what it took. A SQL Server read at the same point takes what is free.
        {
            var limits = ShareLimits();
            var pool = new StringPool(new IndexBudget(limits.MemoryBytes));
            var detail = new BigQueryDetail(null, null, null, [.. Enumerable.Range(0, 40).Select(at => new BigQueryColumn("c" + at, false, "STRING", true, null))]);
            List<BigQueryEntry> entries = [new("bqTable", "bqTables", null, "orders", 1, null, Detail: detail)];
            BigQueryReader Reader() => new(limits, pool, null, limits.BigQueryNamesFloorBytes, limits.BigQueryDetailsFloorBytes);
            pool.Budget.Force(limits.MemoryBytes - limits.BigQueryDetailsFloorBytes);
            var before = pool.Budget.Used;
            var whole = Reader().Read("p", "d", entries, true, true);
            var given = pool.Budget.Used == before;
            var names = Reader().Read("p", "d", entries, false, true);
            check(whole is null && given && names is { ChildrenLeftOut: true, Table.Count: 2 },
                "at the details' floor a BigQuery dataset's columns are refused, giving back what the read took, and its names are kept");
            pool.Budget.Force(pool.Budget.Free - limits.BigQueryNamesFloorBytes);
            before = pool.Budget.Used;
            var refused = Reader().Read("p", "e", entries, false, true);
            var sql = await new DatabaseReader("Sales", limits, pool).ReadAsync(SearchCostChecks.Procedures(20), true, CancellationToken.None, children: false);
            check(refused is null && sql is { Modules: 20, LeftOut: 0 } && pool.Budget.Used > before && pool.Budget.Free >= limits.NamesReserveBytes,
                $"at the names floor BigQuery takes nothing more, and SQL Server still keeps its definitions ({sql?.Modules}; {pool.Budget.Free} bytes free)");
            check(limits.BigQueryDetailsFloor(discovered: true, holds: false) == limits.BigQueryDiscoveredFloorBytes && limits.BigQueryDetailsFloor(true, true) == limits.BigQueryDetailsFloorBytes
                && limits.BigQueryDetailsFloor(false, false) == limits.BigQueryDetailsFloorBytes && limits.BigQueryDetailsFloor(false, true) == limits.BigQueryNamesFloorBytes,
                "a dataset that already holds details keeps one floor less free than its project's, never less than the names floor");
            // A read no larger than the one it replaces fits its share, whatever the budget: a table dropped and one added (its
            // name pooled already), with nothing free, pays the new name from what the dropped table's columns held; and a
            // column added where a table without details went pays from what that table's name held.
            {
                var none = new StringPool(new IndexBudget(limits.MemoryBytes));
                BigQueryDetail Columns(int count) => new(null, null, null, [.. Enumerable.Range(0, count).Select(at => new BigQueryColumn("c" + at, false, "STRING", true, null))]);
                BigQueryReader Replacing(DatabaseIndex earlier) => new(limits, none, earlier, limits.BigQueryNamesFloorBytes, limits.BigQueryDetailsFloorBytes);
                var index = new ConnectionIndex(none.Budget, pool: none);
                var first = new BigQueryReader(limits, none, null).Read("p", "d",
                    [new("bqTable", "bqTables", null, "t1", 1, null, Detail: Columns(20)), new("bqTable", "bqTables", null, "t2", 1, null, Detail: Columns(30)), new("bqTable", "bqTables", null, "t3", 1, null)], true, true)!;
                index.Put(first);
                var sibling = none.TryAcquire("t4");
                none.Budget.Force(none.Budget.Free);
                var used = none.Budget.Used;
                var swapped = Replacing(first).Read("p", "d",
                    [new("bqTable", "bqTables", null, "t1", 1, null, Detail: Columns(20)), new("bqTable", "bqTables", null, "t3", 1, null), new("bqTable", "bqTables", null, "t4", 1, null)], true, true);
                if (swapped is not null) index.Put(swapped);
                var afterSwap = none.Budget.Used;
                // t3 (a name, no details) goes and t1 gains a column whose name the pool holds (t4): the column's record is paid
                // from what t3's name held.
                var wider = swapped is null ? null : Replacing(swapped).Read("p", "d",
                    [new("bqTable", "bqTables", null, "t1", 1, null, Detail: new(null, null, null, [.. Columns(20).Columns, new BigQueryColumn("t4", false, "STRING", true, null)])), new("bqTable", "bqTables", null, "t4", 1, null)], true, true);
                if (wider is not null) index.Put(wider);
                check(swapped is { Table.Count: 1 + 21 + 2 } && afterSwap < used && wider is { Table.Count: 1 + 22 + 1 } && none.Budget.Used <= afterSwap && none.Budget.Free >= 0,
                    $"a read no larger than the one it replaces fits its share with nothing free, names and details lending to each other ({swapped?.Table.Count} then {wider?.Table.Count} entries, {used} then {none.Budget.Used} bytes)");
                none.Release([sibling]);
            }
            // A read given no floors (as only checks build one) still leaves the names' reserve to names when it keeps view text.
            var view = new BigQueryDetail(null, null, "SELECT 1 AS a FROM t", []);
            var reserved = new BigQueryReader(new ObjectIndexLimits { NamesReserveBytes = long.MaxValue / 4 }, new StringPool(new IndexBudget(limits.MemoryBytes)), null)
                .Read("p", "v", [new("bqView", "bqViews", null, "v", 1, null, Detail: view)], true, true);
            check(reserved is { Cut: 1, LeftOut: 1, Table.Count: 2 }, "view text is never kept below the names' reserve, whatever floor the read was given");
        }

        // 3. What the status says when memory did run out: the definitions left out, and where.
        {
            var limits = ShareLimits();
            using var search = new ObjectSearchService(new UnusedHost(), limits);
            var id = Guid.NewGuid().ToString();
            search.Held(id).Put((await SqlRead(search, "Kept", 5))!);
            search.Budget.Force(search.Budget.Free - limits.NamesReserveBytes + 1);
            var starved = await SqlRead(search, "Starved", 7);
            search.Held(id).Put(starved!);
            // Held makes a SQL Server state; the BigQuery flag only spares the status the host's profile, which these checks have none of.
            var status = search.IndexStatus(new ObjectIndexStatusArgs(id), bigQuery: true).Status;
            var wire = System.Text.Json.JsonSerializer.SerializeToElement(status, Wire);
            check(starved is { Modules: 0, Cut: 7, LeftOut: 7 } && status is { Modules: 5, Cut: 7, LeftOut: 7, LeftOutIn: 1 }
                && wire.GetProperty("leftOut").GetInt32() == 7 && wire.GetProperty("leftOutIn").GetInt32() == 1,
                $"a status counts the definitions left out for memory and the databases they belong to ({status.LeftOut} in {status.LeftOutIn})");
            // The server's own objects are in no database: they add to the count, not to the databases.
            var serverText = SearchCostChecks.Procedures(2);
            search.Held(id).PutServer((await new DatabaseReader(ObjectSearchService.ServerScope, limits, search.Pool).ReadAsync(serverText, true, CancellationToken.None, children: false))!);
            status = search.IndexStatus(new ObjectIndexStatusArgs(id), bigQuery: true).Status;
            check(status is { LeftOut: 9, LeftOutIn: 1 }, $"definitions left out of the server's own objects count, in no database ({status.LeftOut} in {status.LeftOutIn})");
            var healthy = System.Text.Json.JsonSerializer.SerializeToElement(new ObjectIndexStatus("ready", 1, 1, 5, 5, 0, [], true), Wire);
            check(!healthy.TryGetProperty("leftOut", out _) && !healthy.TryGetProperty("leftOutIn", out _), "a status with nothing left out for memory carries neither count");
        }

        // A BigQuery index's status counts them by dataset.
        {
            using var search = new ObjectSearchService(new UnusedHost(), ShareLimits());
            var id = Guid.NewGuid().ToString();
            await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), AllProjects: false), ShareSource(), CancellationToken.None);
            var view = new BigQueryDetail(null, null, "SELECT 1 AS a FROM t", []);
            var floor = search.Budget.Free;
            var short1 = new BigQueryReader(search.Limits, search.Pool, null, 0, floor).Read("varia-alpha", "views", [new("bqView", "bqViews", null, "v", 1, null, Detail: view)], true, true)!;
            search.Held(id).Put(short1);
            var status = search.IndexStatus(new ObjectIndexStatusArgs(id), bigQuery: true).Status;
            check(short1 is { LeftOut: 1, Cut: 1 } && status is { Provider: Providers.BigQuery, LeftOut: 1, LeftOutIn: 1, Cut: 1 },
                $"a BigQuery status counts the view and routine text left out for memory, by dataset ({status.LeftOut} in {status.LeftOutIn})");
        }

        // 4. The limit a build carries: checked, applied from that build on with the reserve and floors in proportion, and never
        // dropping what is held when it is lowered.
        {
            using var search = new ObjectSearchService(new UnusedHost());
            var id = Guid.NewGuid().ToString();
            async Task<string?> Refused(ObjectIndexArgs args, bool bigQuery)
            {
                try
                {
                    if (bigQuery) await search.IndexBigQueryAsync(args, ShareSource(), CancellationToken.None);
                    else await search.IndexAsync(args, CancellationToken.None);
                    return null;
                }
                catch (RequestException error) { return error.Code + ": " + error.Message; }
            }
            var low = await Refused(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), MemoryLimitMiB: ObjectIndexLimits.MinMemoryMiB - 1), bigQuery: true);
            var high = await Refused(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), MemoryLimitMiB: ObjectIndexLimits.MaxMemoryMiB + 1), bigQuery: true);
            // SQL Server's build refuses it before it asks the host for the connection (these checks have no host).
            var sqlLow = await Refused(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), MemoryLimitMiB: 0), bigQuery: false);
            var sqlHigh = await Refused(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), MemoryLimitMiB: int.MaxValue), bigQuery: false);
            check(new[] { low, high, sqlLow, sqlHigh }.All(answer => answer == "INVALID_PARAMS: Invalid object search request: memoryLimitMiB.")
                && search.Budget.Limit == ObjectIndexLimits.DefaultMemoryMiB * 1024L * 1024,
                $"a memory limit outside {ObjectIndexLimits.MinMemoryMiB}..{ObjectIndexLimits.MaxMemoryMiB} MiB is refused on both engines and changes nothing: {low} / {sqlHigh}");
            var built = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), MemoryLimitMiB: ObjectIndexLimits.MinMemoryMiB), ShareSource(), CancellationToken.None);
            const long MiB = 1024 * 1024;
            check(built.Status.State == "ready" && search.Budget.Limit == 64 * MiB && search.Limits is { MemoryBytes: 64 * MiB, NamesReserveBytes: 16 * MiB,
                    BigQueryNamesFloorBytes: 24 * MiB, BigQueryDetailsFloorBytes: 28 * MiB, BigQueryDiscoveredFloorBytes: 32 * MiB },
                $"a build's memory limit reaches the budget, with the names' reserve and BigQuery's floors in proportion ({search.Budget.Limit}, {search.Limits.NamesReserveBytes})");
            await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), ShareSource(), CancellationToken.None);
            check(search.Budget.Limit == 64 * MiB, "a build that names no limit leaves it as it is");
            var defaults = new ObjectIndexLimits();
            check(defaults is { MemoryBytes: 512 * MiB, NamesReserveBytes: 128 * MiB, BigQueryNamesFloorBytes: 192 * MiB, BigQueryDetailsFloorBytes: 224 * MiB, BigQueryDiscoveredFloorBytes: 256 * MiB },
                "the default limit keeps 128 MiB for names and 192, 224 and 256 MiB free of BigQuery's names, details and discovered details");
        }
        {
            var limits = ShareLimits();
            using var search = new ObjectSearchService(new UnusedHost(), limits);
            var id = Guid.NewGuid().ToString();
            var sales = await SqlRead(search, "Sales", 60);
            search.Held(id).Put(sales!);
            var used = search.Budget.Used;
            // Lowered below what is held (the setting cannot go this low; the rule is the same).
            search.Budget.Limit = used / 2;
            var again = await SqlRead(search, "Sales", 60, sales);
            search.Held(id).Put(again!);
            var refused = await SqlRead(search, "Archive", 60);
            check(search.Budget.Used == used && again is { Modules: 60, LeftOut: 0 } && refused is null && search.Held(id).Databases.Count == 1 && search.Budget.Free < 0,
                $"a limit lowered below what the index holds drops nothing, a rebuild of what is held still fits, and nothing new is taken ({search.Budget.Used} of {search.Budget.Limit})");
        }
    }
}
