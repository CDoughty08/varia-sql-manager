using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live Object Explorer checks (VARIA_TEST_SQL_SERVER): built-in databases for every version band and both scope
/// strategies, paging against independent queries, cancellation, and with VARIA_TEST_SQL_SCRATCH=1 a scratch database
/// whose fixture rows are checked label by label.</summary>
internal static class ExplorerLiveChecks
{
    private static readonly ObjectRefDto Server = new("server");
    private static NodeRefDto Object(ObjectRefDto value) => new("object", value);
    private static NodeRefDto Folder(ObjectRefDto owner, string folder) => new("folder", Owner: owner, Folder: folder);
    private static ObjectRefDto Database(string name) => new("database", Name: name);
    private static string Show(ExplorerNode node) => node.Label + (node.Sublabel is null ? "" : " " + node.Sublabel);

    private sealed class Client(SqlService service, string connectionId, JsonSerializerOptions json)
    {
        public string ConnectionId { get; } = connectionId;
        public int Requests;

        public async Task<ExplorerChildrenResult> Children(NodeRefDto node, string? subtype = null, string? cursor = null, int? pageSize = null, ExplorerFilterDto? filter = null,
            RequestContext? context = null, string? connectionId = null)
        {
            Interlocked.Increment(ref Requests);
            var args = new ExplorerChildrenArgs(connectionId ?? ConnectionId, Guid.NewGuid().ToString(), node, subtype, cursor, pageSize, filter);
            return (ExplorerChildrenResult)await service.DispatchAsync("explorer.children", JsonSerializer.SerializeToElement(args, json), json, context);
        }

        /// <summary>Every page of a node: the nodes, the first page's total, and how many pages it took.</summary>
        public async Task<(List<ExplorerNode> Nodes, int? Total, int Pages, ExplorerError? Error)> All(NodeRefDto node, int? pageSize = null, ExplorerFilterDto? filter = null, string? subtype = null)
        {
            var nodes = new List<ExplorerNode>();
            string? cursor = null;
            int? total = null;
            var pages = 0;
            do
            {
                var page = await Children(node, subtype, cursor, pageSize, filter);
                pages++;
                if (page.Error is not null) return (nodes, total, pages, page.Error);
                if (pages == 1) total = page.Total;
                nodes.AddRange(page.Nodes);
                cursor = page.Cursor;
            } while (cursor is not null && pages < 10_000);
            return (nodes, total, pages, null);
        }

        public async Task<List<string>> Labels(NodeRefDto node, ExplorerFilterDto? filter = null, string? subtype = null) =>
            [.. (await All(node, filter: filter, subtype: subtype)).Nodes.Select(Show)];
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, string? sqlUser, JsonSerializerOptions json)
    {
        var client = new Client(service, info.Id, json);
        async Task<SqlRun> Sql(string sql, string database = "master")
        {
            var session = Guid.NewGuid().ToString();
            try
            {
                // Fixtures stop at their first error, so a batch that failed cannot leave later ones to run in the wrong place.
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, session, database, sql, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json); }
        }
        var options = service.Explorer.Options;
        var major = int.Parse(info.ServerVersion.Split('.')[0]);

        check(info.ProductVersion is { Length: > 0 } && info.Login is { Length: > 0 } && info.EngineEdition is > 0, "connect probes the server profile: product version, login and engine edition");
        bool linux;
        await using (var probe = new SqlConnection(ConnectionSettings.Build(live("master")).ConnectionString))
        {
            await probe.OpenAsync();
            var profile = await ServerProfile.ProbeAsync(probe, CancellationToken.None);
            check(profile.Major == major && profile.CatalogBand == Math.Min(ExplorerCatalog.BandOf(major), 16),
                "the profile's catalog band matches the version's on a box server (" + profile.CatalogBand + " on " + major + ")");
            await using var platform = probe.CreateCommand();
            platform.CommandText = "SELECT host_platform FROM sys.dm_os_host_info;";
            linux = major >= 14 && await platform.ExecuteScalarAsync() is "Linux";
            check(profile.Linux == linux, "the profile says whether SQL Server runs on Linux, as sys.dm_os_host_info does (" + (linux ? "Linux" : "Windows") + ")");
        }
        check((await client.Labels(Object(Server))).SequenceEqual(["Databases", "Security", "Server Objects", "Integration Services Catalogs"]), "the server's folders, in SSMS order");
        // Without a catalog the folder is empty on Windows; SQL Server on Linux cannot have one, and the folder says so.
        if (!(await client.Labels(Folder(Server, "databases"))).Contains("SSISDB"))
        {
            var catalogs = await client.Children(Folder(Server, "integrationServicesCatalogs"));
            check(linux ? catalogs is { Nodes.Count: 0, Error: { Code: "NOT_SUPPORTED", Retryable: false } } : catalogs is { Nodes.Count: 0, Error: null },
                "Integration Services Catalogs is empty without SSISDB on Windows, and says the catalog is not supported on Linux: " + catalogs.Error?.Message);
        }
        var system = await client.All(Folder(Server, "systemDatabases"));
        check(system.Nodes.Select(node => node.Label).SequenceEqual(["master", "model", "msdb", "tempdb"]) && system.Nodes.All(node => node is { Subtype: "system", Icon: "database", HasChildren: true }),
            "System Databases lists exactly master, model, msdb and tempdb");
        var logins = await client.Labels(Folder(Server, "logins"));
        var roles = await client.All(Folder(Server, "serverRoles"));
        check(logins.Contains(sqlUser ?? info.Login!) && roles.Nodes.Any(node => node is { Label: "sysadmin", Detail: "Fixed server role", Icon: "role" }), "Logins include the test login; Server Roles include sysadmin");

        // Paging: 97 rows a page, compared with one independent ORDER BY.
        var procedures = await client.All(Folder(Database("master"), "systemStoredProcedures"), pageSize: 97);
        var expected = await Sql("SELECT s.name + N'.' + p.name FROM sys.all_objects AS p JOIN sys.schemas AS s ON s.schema_id = p.schema_id "
            + "LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = p.object_id AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support' "
            + "WHERE p.type IN ('P', 'PC', 'X', 'RF') AND (p.is_ms_shipped = 1 OR ep.major_id IS NOT NULL) ORDER BY s.name, p.name;");
        var labels = procedures.Nodes.Select(node => node.Label).ToList();
        check(procedures.Error is null && procedures.Pages > 10 && labels.Count == procedures.Total && labels.Distinct().Count() == labels.Count
            && labels.SequenceEqual(expected.Sets[0].Select(row => row[0]!)), "System Stored Procedures pages of 97 have no gaps or duplicates and match one ORDER BY (" + procedures.Pages + " pages)");
        check(procedures.Nodes.Any(node => node is { Label: "sys.xp_msver", Subtype: "extended" }) && procedures.Nodes.Any(node => node is { Label: "sys.sp_who", Subtype: "system" }),
            "System Stored Procedures marks extended procedures (sys.xp_msver) 'extended' and the others (sys.sp_who) 'system'");
        var columns = await client.All(Folder(new ObjectRefDto("view", "master", "INFORMATION_SCHEMA", "TABLES"), "columns"));
        check(columns.Nodes.Any(node => Show(node) == "TABLE_CATALOG (nvarchar(128), null)"), "System Views › INFORMATION_SCHEMA.TABLES › Columns shows TABLE_CATALOG (nvarchar(128), null)");

        // Every folder under the system databases expands, for every band up to the server's and with a pool per database.
        var errors = new List<string>();
        var before = client.Requests;
        foreach (var band in Enumerable.Range(ExplorerCatalog.MinBand, Math.Max(0, Math.Min(major, ExplorerCatalog.MaxBand) - ExplorerCatalog.MinBand + 1)))
        {
            options.ForceBand = band;
            foreach (var database in new[] { "master", "msdb", "tempdb" }) await Walk(client, Object(Database(database)), null, 5, database + " @" + band, errors);
            await Walk(client, Object(Server), null, 2, "server @" + band, errors);
        }
        options.ForceBand = null;
        options.ForcePerDatabaseScope = true;
        foreach (var database in new[] { "master", "msdb" }) await Walk(client, Object(Database(database)), null, 5, database + " per database", errors);
        options.ForcePerDatabaseScope = false;
        check(errors.Count == 0, "every folder under master, msdb and tempdb expands for bands 12-" + Math.Min(major, 17) + " and with a pool per database ("
            + (client.Requests - before) + " requests): " + string.Join(" | ", errors.Take(5)));

        // The size cut ends a page early with a cursor; the pages still add up.
        options.SizeCut = 4000;
        var cut = await client.All(Folder(Database("master"), "systemViews"));
        options.SizeCut = new ExplorerOptions().SizeCut;
        var whole = await client.All(Folder(Database("master"), "systemViews"));
        check(cut.Pages > 10 && cut.Nodes.Select(node => node.Label).SequenceEqual(whole.Nodes.Select(node => node.Label)) && whole.Pages == 1, "the size cut splits pages without losing rows (" + cut.Pages + " pages)");

        var missing = "VariaMissing_" + Guid.NewGuid().ToString("N");
        var gone = await client.Children(Folder(Database(missing), "tables"));
        var goneNode = await client.Children(Object(Database(missing)));
        var goneTable = await client.Children(Folder(new ObjectRefDto("table", "msdb", "dbo", "VariaNoSuchTable"), "columns"));
        check(gone.Error is { Code: "NOT_FOUND", Action: "refreshParent" } && goneNode.Error?.Code == "NOT_FOUND" && goneTable.Error is { Code: "NOT_FOUND", Action: "refreshParent", Message: "dbo.VariaNoSuchTable no longer exists." },
            "a missing database or parent object is NOT_FOUND with refresh-parent");

        await KindListsAsync(check, service, info.Id, text => Sql(text));
        await CancellationAsync(check, service, client, live, json);
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Scratch-database checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        await ScratchAsync(check, service, client, live, json, (text, database) => Sql(text, database));
    }

    /// <summary>Kinds that list rows after their static folders (S1b's SSIS catalog lists its folders so), through catalogue
    /// variants: master listing its schemas by name, and its objects by a bigint key past int's range, in both scope
    /// strategies, page by page against one independent ORDER BY.</summary>
    private static async Task KindListsAsync(Action<bool, string> check, SqlService host, string connectionId, Func<string, Task<SqlRun>> sql)
    {
        static async Task<(List<ExplorerNode> Nodes, int? Total, int Pages, ExplorerError? Error)> All(ExplorerService service, string connectionId, int pageSize)
        {
            var nodes = new List<ExplorerNode>();
            string? cursor = null;
            int? total = null;
            var pages = 0;
            do
            {
                var page = await service.ChildrenAsync(new(connectionId, Guid.NewGuid().ToString(), Object(Database("master")), Cursor: cursor, PageSize: pageSize), CancellationToken.None);
                if (page.Error is not null) return (nodes, total, pages, page.Error);
                if (pages++ == 0) total = page.Total;
                nodes.AddRange(page.Nodes);
                cursor = page.Cursor;
            } while (cursor is not null && pages < 10_000);
            return (nodes, total, pages, null);
        }
        var folders = (await host.Explorer.ChildrenAsync(new(connectionId, Guid.NewGuid().ToString(), Object(Database("master"))), CancellationToken.None)).Nodes.Select(node => node.Ref.Folder).ToList();

        using (var schemas = new ExplorerService(host, catalog: ExplorerChecks.Variant(json => ExplorerChecks.SetKind(json, "database", ("list", "schemas"), ("rows", new JsonArray("schema"))))))
        {
            var listed = await All(schemas, connectionId, 3);
            var expected = (await sql("SELECT s.name FROM sys.schemas AS s ORDER BY s.name;")).Sets[0].Select(row => row[0]!).ToList();
            var rows = listed.Nodes.Skip(folders.Count).ToList();
            check(listed.Error is null && folders.Count > 5 && listed.Nodes.Take(folders.Count).Select(node => node.Ref.Folder).SequenceEqual(folders)
                && rows.All(node => node.Ref is { Type: "object", Object.Kind: "schema" }) && rows.Select(node => node.Label).SequenceEqual(expected)
                && listed.Total == folders.Count + expected.Count && listed.Pages > 3,
                "a database kind that lists its schemas serves its folders first, then pages of 3 schemas matching one ORDER BY (" + listed.Pages + " pages; " + listed.Error?.Message + ")");
        }

        var queries = ExplorerQueries.All.Append(new(ExplorerChecks.Ids.Id, ExplorerChecks.Ids)).ToDictionary(StringComparer.Ordinal);
        var ids = ExplorerChecks.Variant(json => ExplorerChecks.SetKind(json, "database", ("list", ExplorerChecks.Ids.Id), ("rows", new JsonArray("schema"))));
        var keys = (await sql("SELECT CONVERT(bigint, o.object_id) + 4294967296 FROM sys.all_objects AS o ORDER BY 1;")).Sets[0].Select(row => row[0]!).ToList();
        foreach (var perDatabase in new[] { false, true })
        {
            using var service = new ExplorerService(host, new ExplorerOptions { ForcePerDatabaseScope = perDatabase }, ids, queries);
            var listed = await All(service, connectionId, 500);
            var labels = listed.Nodes.Skip(folders.Count).Select(node => node.Label).ToList();
            check(listed.Error is null && labels.SequenceEqual(keys) && listed.Pages > 2 && labels.Distinct().Count() == labels.Count && labels.All(label => long.Parse(label, CultureInfo.InvariantCulture) > int.MaxValue),
                "a bigint keyset (Keyset.Id) pages master's " + keys.Count + " objects past int's range without gaps or duplicates" + (perDatabase ? " on a pool per database" : " through the scope wrapper")
                + " (" + listed.Pages + " pages, " + labels.Count + " rows; " + listed.Error?.Message + "; first difference at " + Enumerable.Range(0, Math.Min(labels.Count, keys.Count)).FirstOrDefault(i => labels[i] != keys[i], -1) + ")");
        }

        // The server receives each owner field in its own parameter, verbatim: an SSIS ref's name, folder and project at
        // server scope, and a database's name through both scope strategies.
        var (serverEcho, databaseEcho) = (ExplorerChecks.Echo(QueryScope.Server), ExplorerChecks.Echo(QueryScope.Database));
        var echoes = ExplorerQueries.All.Append(new(serverEcho.Id, serverEcho)).Append(new(databaseEcho.Id, databaseEcho)).ToDictionary(StringComparer.Ordinal);
        var ssis = ExplorerChecks.Variant(json =>
        {
            ExplorerChecks.SetKind(json, "login", ("scope", "ssisProjectObject"), ("list", serverEcho.Id), ("rows", new JsonArray("credential")));
            ExplorerChecks.SetKind(json, "database", ("list", databaseEcho.Id), ("rows", new JsonArray("credential")));
        });
        var package = new ObjectRefDto("login", Name: "Daily ]' 😀", SsisFolder: "Finance [x]", SsisProject: "Loads; --");
        foreach (var perDatabase in new[] { false, true })
        {
            using var service = new ExplorerService(host, new ExplorerOptions { ForcePerDatabaseScope = perDatabase }, ssis, echoes);
            var owned = await service.ChildrenAsync(new(connectionId, Guid.NewGuid().ToString(), Object(package)), CancellationToken.None);
            var master = await service.ChildrenAsync(new(connectionId, Guid.NewGuid().ToString(), Object(Database("master"))), CancellationToken.None);
            var labels = owned.Nodes.Select(node => node.Label).Append(master.Nodes.LastOrDefault()?.Label).ToList();
            check(owned.Error is null && master.Error is null && labels.SequenceEqual(["Daily ]' 😀|-|Finance [x]|Loads; --", "master|-|-|-"]),
                "a listing receives its owner's name, schema, SSIS folder and project in their own parameters" + (perDatabase ? " on a pool per database" : " through the scope wrapper")
                + ": " + string.Join(" / ", labels) + " " + owned.Error?.Message + master.Error?.Message);
        }
    }

    /// <summary>The children a walk expands: those that have children, except temp tables (tempdb's # names, including the
    /// engine's cached #A1B2C3D4 objects), which can vanish between listing and expanding, and scratch databases, this
    /// run's or another run's on the same server, which can be mid-setup, single-user with another session in them,
    /// offline or being dropped. The scratch checks expand this run's on purpose.</summary>
    private static bool Walked(ExplorerNode child) => child.HasChildren && child.Ref.Object?.Name?.StartsWith('#') != true
        && !(child.Ref.Object is { Kind: "database", Name: { } name } && ScratchDatabase.IsScratchName(name));

    /// <summary>Expands a node and, <paramref name="depth"/> levels down, every folder and the first object of each list
    /// that <see cref="Walked"/> takes, recording each failure with its path.</summary>
    private static async Task Walk(Client client, NodeRefDto node, string? subtype, int depth, string path, List<string> errors)
    {
        ExplorerChildrenResult result;
        try { result = await client.Children(node, subtype); }
        catch (RequestException error) { errors.Add(path + ": " + error.Code); return; }
        // SQL Server on Linux cannot have an SSIS Catalog: its folder answers so, by design.
        if (result.Error is { Code: "NOT_SUPPORTED" } && node is { Type: "folder", Folder: "integrationServicesCatalogs" }) return;
        if (result.Error is not null) { errors.Add(path + ": " + result.Error.Code + " " + result.Error.Message); return; }
        if (depth == 0) return;
        var objects = 0;
        foreach (var child in result.Nodes.Where(Walked))
            if (child.Ref.Type == "folder" || objects++ < 1) await Walk(client, child.Ref, child.Subtype, depth - 1, path + " › " + child.Label, errors);
    }

    private static async Task CancellationAsync(Action<bool, string> check, SqlService service, Client client, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        var options = service.Explorer.Options;
        var logins = Folder(Server, "logins");
        options.TestDelay = TimeSpan.FromSeconds(10);
        try
        {
            using (var context = new RequestContext(1, "explorer.children", RequestLane.Explorer, 0))
            {
                var watch = Stopwatch.StartNew();
                var running = client.Children(logins, context: context);
                await Task.Delay(300);
                context.Cancel(CancelReason.User);
                var stopped = await Stops(running);
                check(stopped && watch.ElapsedMilliseconds < 2300 && service.Explorer.RunningCount == 0, "a CANCEL stops a running catalog statement within 2 s (" + watch.ElapsedMilliseconds + " ms)");
            }
            using (var context = new RequestContext(2, "explorer.children", RequestLane.Explorer, 0))
            {
                context.Cancel(CancelReason.User);
                var watch = Stopwatch.StartNew();
                check(await Stops(client.Children(logins, context: context)) && watch.ElapsedMilliseconds < 500, "a request cancelled before it runs ends at once");
            }
            options.Budget = TimeSpan.FromSeconds(1);
            var budget = await client.Children(logins);
            check(budget.Error is { Code: "TIMEOUT", Retryable: true }, "the request budget ends a slow statement as a TIMEOUT value");
            options.Budget = new ExplorerOptions().Budget;
            var other = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master"), json), json);
            var pending = client.Children(logins, connectionId: other.Id);
            await Task.Delay(300);
            var disconnected = Stopwatch.StartNew();
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(other.Id), json), json);
            try { await pending; check(false, "a disconnected connection's request completed"); }
            catch (RequestException error) { check(error.Code == "CANCELLED" && disconnected.ElapsedMilliseconds < 2000, "disconnect cancels the connection's running catalog statements"); }
        }
        finally
        {
            options.TestDelay = null;
            options.Budget = new ExplorerOptions().Budget;
        }
        var after = await client.Children(logins);
        check(after.Error is null && after.Nodes.Count > 0, "the Object Explorer pool serves the next request after cancellations");
    }

    private static async Task<bool> Stops(Task task)
    {
        try { await task; return false; }
        catch (OperationCanceledException) { return true; }
        catch (SqlException) { return true; }
    }

    private static async Task ScratchAsync(Action<bool, string> check, SqlService service, Client client, Func<string, ConnectOptions> live, JsonSerializerOptions json,
        Func<string, string, Task<SqlRun>> sql)
    {
        await ScratchDatabase.SweepAsync(sql);
        var watch = Stopwatch.StartNew();
        await using var scratch = await ScratchDatabase.CreateAsync(sql, Path.Combine(AppContext.BaseDirectory, "Fixtures"));
        Console.WriteLine("Created the Object Explorer scratch database in " + watch.ElapsedMilliseconds + " ms.");
        var major = scratch.Major;
        var db = Database(scratch.Name);
        var dbName = scratch.Name;
        ObjectRefDto Table(string schema, string name) => new("table", dbName, schema, name);
        Task<List<string>> Labels(ObjectRefDto owner, string folder, ExplorerFilterDto? filter = null) => client.Labels(Folder(owner, folder), filter);
        ExplorerFilterDto Schema(string schema) => new(Schema: new("equals", schema));

        var databases = (await client.All(Folder(Server, "databases"))).Nodes.Where(node => node.Label.StartsWith(scratch.Name, StringComparison.Ordinal)).ToList();
        check(databases.Select(node => (Show(node), node.Status, node.HasChildren)).SequenceEqual([(scratch.Name, null, true), (scratch.Offline + " (Offline)", "unavailable", false),
            (scratch.ReadOnly + " (Read-Only)", "readOnly", true), (scratch.SingleUser + " (Single User)", null, true)]),
            "scratch databases: offline ones do not expand, read-only and single-user ones say so: " + string.Join(", ", databases.Select(Show)));
        check((await client.Children(Object(Database(scratch.Offline)))).Error?.Code == "DATABASE_UNAVAILABLE", "expanding an offline database explains why");
        // Another session in a single-user database makes HAS_DBACCESS wait about 2 s and then deny access.
        await using (var holder = new SqlConnection(new SqlConnectionStringBuilder(ConnectionSettings.Build(live(scratch.SingleUser)).ConnectionString) { Pooling = false }.ConnectionString))
        {
            await holder.OpenAsync();
            var held = Stopwatch.StartNew();
            var listed = (await client.All(Folder(Server, "databases"), pageSize: 1)).Nodes.SingleOrDefault(node => node.Label == scratch.SingleUser);
            var listMs = held.ElapsedMilliseconds;
            var expanded = await client.Children(Object(Database(scratch.SingleUser)));
            check(listed is { Status: null, HasChildren: true } && listMs < 1500, "a single-user database another session is in is listed at once, not as inaccessible (" + listMs + " ms, one row a page)");
            check(expanded.Error is { Code: "DATABASE_UNAVAILABLE", Retryable: true } && expanded.Error.Message.Contains("Single User", StringComparison.Ordinal),
                "expanding a single-user database another session is in says it is unavailable, and can be retried: " + expanded.Error?.Message);
            // A parallel run's walk meets this run's scratch databases in just this state (and mid-setup or being dropped):
            // the walk must leave every scratch database alone, whichever list position it has.
            var walkErrors = new List<string>();
            await Walk(client, Object(Server), null, 2, "server", walkErrors);
            var scratchNodes = (await client.All(Folder(Server, "databases"))).Nodes
                .Where(node => node.Ref.Object is { Kind: "database", Name: { } name } && ScratchDatabase.IsScratchName(name)).ToList();
            check(walkErrors.Count == 0 && scratchNodes.Any(node => node is { HasChildren: true } && node.Label == scratch.SingleUser) && !scratchNodes.Any(Walked),
                "the walk skips scratch databases (own and other runs'), such as a single-user one another session is in ("
                + scratchNodes.Count(Walked) + " of " + scratchNodes.Count + " walked): " + string.Join(" | ", walkErrors.Take(5)));
        }
        if (scratch.HasSnapshot)
        {
            var snapshot = (await client.All(Folder(Server, "databaseSnapshots"))).Nodes.SingleOrDefault(node => node.Label == scratch.Snapshot);
            check(snapshot is { Subtype: "snapshot", Icon: "device-camera", HasChildren: true } && (await Labels(Database(scratch.Snapshot), "tables", Schema("dbo"))).Contains("dbo.a"),
                "the snapshot is under Database Snapshots and expands");
        }
        var folders = await client.Labels(Object(db));
        check(folders.SequenceEqual(["Tables", "Views", "External Resources", "Synonyms", "Programmability", "Storage", "Security"]), "the scratch database's folders: " + string.Join(", ", folders));

        // Tables: user tables only (history, graph and dropped ledger tables live elsewhere), in the database's case-sensitive order.
        var dbo = await Labels(db, "tables", Schema("dbo"));
        var dboTables = dbo.Where(label => label.StartsWith("dbo.", StringComparison.Ordinal)).ToList();
        var order = await sql("SELECT N'dbo.' + t.name FROM sys.tables AS t WHERE t.schema_id = SCHEMA_ID(N'dbo') AND t.name IN (N'a', N'A', N'b', N'Doomed', N'Ünïcødé表', N'50%_off', N'50x_off', N'[x]', N'Embeddings') ORDER BY t.name;", dbName);
        var expectedDbo = new List<string> { "dbo.a", "dbo.A", "dbo.b", "dbo.Doomed", "dbo.Ünïcødé表", "dbo.50%_off", "dbo.50x_off", "dbo.[x]" };
        if (major >= 16) expectedDbo.AddRange(["dbo.LedgerAccounts (Updatable Ledger)", "dbo.LedgerEvents (Append-Only Ledger)"]);
        if (major >= 17) expectedDbo.Add("dbo.Embeddings");
        check(dboTables.Order().SequenceEqual(expectedDbo.Order()) && dboTables.Where(label => !label.Contains("Ledger")).SequenceEqual(order.Sets[0].Select(row => row[0]!)),
            "Tables lists the dbo fixture tables in the database's case-sensitive order: " + string.Join(", ", dboTables));
        check((await Labels(db, "tables", Schema("Sales"))).Where(label => label.StartsWith("Sales.")).SequenceEqual(["Sales.Customers", "Sales.Invoices (System-Versioned)", "Sales.Orders"])
            && (await Labels(db, "tables", Schema("Odd]Schema"))).Contains("Odd]Schema.t"), "temporal history tables stay out of Tables; awkward schema names are used verbatim");
        var invoices = await client.All(Object(Table("Sales", "Invoices")), subtype: "systemVersioned");
        check(invoices.Nodes.Select(Show).SequenceEqual(["Sales.InvoicesHistory (History)", "Columns", "Keys", "Constraints", "Triggers", "Indexes", "Statistics"])
            && invoices.Nodes[0] is { Subtype: "history", Icon: "history", HasChildren: true } && invoices.Total == 7, "a temporal table's history row comes first, then its folders");
        check((await client.Labels(Object(Table("Sales", "InvoicesHistory")), subtype: "history")).SequenceEqual(["Columns", "Indexes", "Statistics"]), "a history table has Columns, Indexes and Statistics");
        check((await Labels(Table("Sales", "Invoices"), "columns")).SequenceEqual(["Id (PK, int, not null)", "Amount (money, null)", "ValidFrom (datetime2(7), not null)", "ValidTo (datetime2(7), not null)"])
            && (await client.All(Folder(Table("Sales", "Invoices"), "columns"))).Nodes[2].Detail == "Hidden · Generated always (row start)", "hidden period columns are listed with their facts");

        var customerColumns = (await client.All(Folder(Table("Sales", "Customers"), "columns"))).Nodes;
        check(customerColumns.Select(Show).SequenceEqual(["Id (PK, int, not null)", "Name (Name(nvarchar(50)), not null)", "Email (nvarchar(200), null)", "Created (datetime2(3), not null)",
            "Notes (nvarchar(max), null)", "Doc (XML(DOCUMENT dbo.Coll), null)", "Frag (XML(CONTENT dbo.Coll), null)", "Extra (int, null)"])
            && customerColumns[0] is { Icon: "key", Detail: "Identity" } && customerColumns[7].Detail == "Sparse" && customerColumns[0].Ref.Object!.Parent == new ParentRefDto("table", "Sales", "Customers"),
            "column labels: PK, alias type, max lengths, XML collections, sparse: " + string.Join(", ", customerColumns.Select(Show)));
        var orderColumns = (await client.All(Folder(Table("Sales", "Orders"), "columns"))).Nodes;
        check(orderColumns.Select(Show).SequenceEqual(["Id (PK, int, not null)", "CustomerId (FK, int, null)", "ReferrerId (FK, int, null)", "BackupId (FK, int, null)", "Price (decimal(8,2), not null)",
            "Quantity (int, not null)", "Total (Computed, decimal(19,2), null)", "Payload (varbinary(max), null)"]) && orderColumns[1].Icon == "references" && orderColumns[6].Icon == "symbol-operator",
            "column labels: FK, decimal, computed: " + string.Join(", ", orderColumns.Select(Show)));
        var keys = (await client.All(Folder(Table("Sales", "Orders"), "keys"))).Nodes;
        check(keys.Select(node => (node.Label, node.Subtype, node.Status, node.Detail)).SequenceEqual([("FK_Orders_Backup", "foreign", "disabled", "Not trusted"), ("FK_Orders_Customers", "foreign", null, null),
            ("FK_Orders_Referrer", "foreign", null, "Not trusted"), ("PK_Orders", "primary", null, null)]) && keys[3].Icon == "key" && keys[0].Icon == "references",
            "keys: primary and foreign, disabled and untrusted");
        check((await client.All(Folder(Table("Sales", "Customers"), "keys"))).Nodes.Select(node => (node.Label, node.Subtype)).SequenceEqual([("PK_Customers", "primary"), ("UQ_Customers_Email", "unique")])
            && (await client.All(Folder(Table("Sales", "Customers"), "constraints"))).Nodes.Select(node => (node.Label, node.Subtype)).SequenceEqual([("DF_Customers_Created", "default")]),
            "unique keys and default constraints");
        var constraints = (await client.All(Folder(Table("Sales", "Orders"), "constraints"))).Nodes;
        check(constraints.Select(node => (node.Label, node.Subtype, node.Status)).SequenceEqual([("CK_Orders_Price", "check", null), ("CK_Orders_Quantity", "check", "disabled")]), "check constraints, one disabled");
        check((await client.All(Folder(Table("Sales", "Orders"), "tableTriggers"))).Nodes.Select(node => (node.Label, node.Status, node.Detail)).SequenceEqual([("TR_Orders_Audit", null, "AFTER"), ("TR_Orders_Off", "disabled", "AFTER")]),
            "table triggers, one disabled");
        var indexes = (await client.All(Folder(Table("Sales", "Orders"), "indexes"))).Nodes;
        check(indexes.Select(node => (Show(node), node.Status, node.Detail)).SequenceEqual([("IX_Orders_Customer (Non-Unique, Non-Clustered)", null, null), ("IX_Orders_Disabled (Non-Unique, Non-Clustered)", "disabled", null),
            ("IX_Orders_Price (Unique, Non-Clustered)", null, "Filtered"), ("PK_Orders (Clustered)", null, "Primary key")]), "indexes: unique, filtered, disabled, clustered: " + string.Join(", ", indexes.Select(Show)));
        check((await Labels(Table("Sales", "Orders"), "statistics")).Contains("ST_Orders_Quantity"), "statistics list user statistics");
        var spaced = (await client.All(Folder(Table("dbo", "b"), "columns"))).Nodes;
        check(spaced.Select(node => node.Label).SequenceEqual(["id", "spaced "]) && spaced[1].Ref.Object!.Name == "spaced ", "names keep their trailing spaces");

        check((await Labels(db, "views", Schema("dbo"))).Where(label => label.StartsWith("dbo.v")).SequenceEqual(["dbo.vCustomers", "dbo.vOrderTotals"])
            && (await client.All(Folder(new ObjectRefDto("view", dbName, "dbo", "vCustomers"), "tableTriggers"))).Nodes.Single() is { Label: "TR_vCustomers", Detail: "INSTEAD OF" }
            && (await Labels(new ObjectRefDto("view", dbName, "dbo", "vOrderTotals"), "indexes")).SequenceEqual(["IX_vOrderTotals (Clustered)"]), "views with an INSTEAD OF trigger and an index");
        check((await client.All(Folder(db, "synonyms"))).Nodes.Single() is { Label: "dbo.syn_Orders", Detail: "Refers to [Sales].[Orders] · Owner dbo", Icon: "link" }, "synonyms say what they refer to");

        var parameters = (await client.All(Folder(new ObjectRefDto("procedure", dbName, "Sales", "usp_Orders"), "parameters"))).Nodes;
        check(parameters.Select(Show).SequenceEqual(["@CustomerId (int, Input, No default)", "@Since (datetime2(3), Input, Default)", "@Count (int, Input/Output, Default)",
            "@Lines (Sales.OrderLines, Input, ReadOnly, No default)", "@Label (nvarchar(20), Input, Default)", "Returns integer"]) && parameters[2].Subtype == "output"
            && parameters[^1] is { Icon: "arrow-left", Ref.Object: { Kind: "returnValue", Name: null } }, "parameters: defaults from the module header, OUTPUT, READONLY, then the return row: " + string.Join(", ", parameters.Select(Show)));
        check((await Labels(new ObjectRefDto("procedure", dbName, "dbo", "usp_Secret"), "parameters")).SequenceEqual(["@x (int, Input)", "Returns integer"]), "an encrypted module's parameters omit the default token");
        var cursorParameters = await Labels(new ObjectRefDto("procedure", dbName, "dbo", "usp_Cursor"), "parameters");
        check(cursorParameters.SequenceEqual(["@Rows (cursor, Input/Output, No default)", "Returns integer"]), "a CURSOR VARYING OUTPUT parameter is typed cursor, not int: " + string.Join(", ", cursorParameters));
        check((await client.All(Folder(db, "tableValuedFunctions"))).Nodes.Select(node => (node.Label, node.Subtype)).SequenceEqual([("dbo.fn_Inline", "inline"), ("dbo.fn_Multi", "tableValued"), ("dbo.fn_Policy", "inline")])
            && (await client.All(Folder(db, "scalarValuedFunctions"))).Nodes.Select(node => (node.Label, node.Subtype)).SequenceEqual([("dbo.fn_Scalar", "scalar")]), "table-valued and scalar functions with their subtypes");
        var inline = new ObjectRefDto("function", dbName, "dbo", "fn_Inline");
        check((await client.Labels(Object(inline), subtype: "inline")).SequenceEqual(["Columns", "Parameters"]) && (await Labels(inline, "columns")).SequenceEqual(["Value (int, null)", "Name (nvarchar(1), not null)"])
            && (await Labels(inline, "parameters")).SequenceEqual(["@x (int, Input, Default)", "Returns Table"])
            && (await Labels(new ObjectRefDto("function", dbName, "dbo", "fn_Scalar"), "parameters")).SequenceEqual(["@a (decimal(10,2), Input, No default)", "@b (int, Input, Default)", "Returns decimal(10,2)"]),
            "function columns, parameters and return rows");
        check((await client.All(Folder(db, "userDefinedDataTypes"))).Nodes.Single() is { Label: "dbo.Name", Sublabel: "(nvarchar(50), not null)", Subtype: "alias" }
            && (await Labels(db, "userDefinedTableTypes")).SequenceEqual(["Sales.OrderLines"]) && (await Labels(db, "xmlSchemaCollections")).SequenceEqual(["dbo.Coll"]),
            "user-defined data and table types, XML schema collections");
        var tableType = new ObjectRefDto("tableType", dbName, "Sales", "OrderLines");
        check((await Labels(tableType, "columns")).SequenceEqual(["Line (PK, int, not null)", "Quantity (int, not null)", "Note (nvarchar(20), null)"])
            && (await client.All(Folder(tableType, "keys"))).Nodes.Single().Subtype == "primary" && (await client.All(Folder(tableType, "constraints"))).Nodes.Single().Subtype == "check"
            && (await Labels(tableType, "indexes")).Any(label => label == "IX_Quantity (Non-Unique, Non-Clustered)"), "a table type's columns, key, constraint and index");
        check((await Labels(db, "sequences")).SequenceEqual(["dbo.seq_Orders"]) && (await Labels(db, "rules")).SequenceEqual(["dbo.r_Positive"]) && (await Labels(db, "defaults")).SequenceEqual(["dbo.d_Zero"])
            && (await client.All(Folder(db, "planGuides"))).Nodes.Single() is { Label: "pg_Orders", Icon: "milestone" }, "sequences, rules, defaults and plan guides");
        check((await client.All(Folder(db, "databaseTriggers"))).Nodes.Select(node => (node.Label, node.Status)).SequenceEqual([("trg_ddl_off", "disabled"), ("trg_ddl_on", null)]), "database DDL triggers, one disabled");
        check((await client.All(Folder(db, "partitionFunctions"))).Nodes.Single() is { Label: "pf_Range", Detail: "3 partitions" }
            && (await client.All(Folder(db, "partitionSchemes"))).Nodes.Single() is { Label: "ps_Range", Detail: "Function pf_Range" }, "partition functions and schemes");
        var users = (await client.All(Folder(db, "users"))).Nodes;
        check(users.Single(node => node.Label == "NoConnect").Status == "disabled" && users.Single(node => node.Label == "NoLoginUser").Status is null && users.Single(node => node.Label == "dbo").Status is null,
            "a user without CONNECT is shown disabled");
        check((await Labels(db, "databaseRoles")).Contains("SalesReaders") && (await client.All(Folder(db, "databaseRoles"))).Nodes.Single(node => node.Label == "db_owner").Detail!.StartsWith("Fixed database role")
            && (await Labels(db, "applicationRoles")).SequenceEqual(["AppRole"]) && (await Labels(db, "schemas")).Intersect(["Sales", "Odd]Schema", "bulk", "INFORMATION_SCHEMA", "sys"]).Count() == 5,
            "roles, application roles and schemas (sys and INFORMATION_SCHEMA included)");
        check((await Labels(db, "asymmetricKeys")).SequenceEqual(["ScratchAsymmetric"]) && (await client.All(Folder(db, "certificates"))).Nodes.Single().Detail == "Subject Varia scratch · Expires 2099-12-31"
            && (await Labels(db, "symmetricKeys")).Order(StringComparer.Ordinal).SequenceEqual(["##MS_DatabaseMasterKey##", "ScratchSymmetric"])
            && (await Labels(db, "columnMasterKeys")).SequenceEqual(["ScratchCmk"]) && (await Labels(db, "columnEncryptionKeys")).SequenceEqual(["ScratchCek"])
            && (await client.All(Folder(db, "securityPolicies"))).Nodes.Single() is { Label: "dbo.CustomerPolicy", Status: "disabled" }, "keys, certificates, Always Encrypted keys and security policies");
        check((await client.All(Folder(db, "fileTables"))).Error is null && (await client.All(Folder(db, "externalTables"))).Error is null && (await client.All(Folder(db, "externalDataSources"))).Error is null,
            "FileTables, External Tables and External Data Sources load (empty or present)");
        if (major >= 14)
        {
            var graph = (await client.All(Folder(db, "graphTables"))).Nodes;
            var expectedGraph = major >= 15 ? new[] { ("dbo.Knows", "graphEdge"), ("dbo.Likes", "graphEdge"), ("dbo.Person", "graphNode") } : [("dbo.Knows", "graphEdge"), ("dbo.Person", "graphNode")];
            check(graph.Select(node => (node.Label, node.Subtype!)).SequenceEqual(expectedGraph) && !dbo.Contains("dbo.Person"), "graph tables are under Graph Tables only");
            check(!(await Labels(Table("dbo", "Person"), "columns")).Any(label => label.StartsWith("graph_id_", StringComparison.Ordinal)), "hidden graph internals are not listed");
        }
        if (major >= 15)
            check((await client.All(Folder(Table("dbo", "Likes"), "constraints"))).Nodes.Single() is { Label: "EC_Likes", Subtype: "edge", Icon: "link" }, "edge constraints");
        if (major >= 16)
        {
            var ledger = await client.All(Object(Table("dbo", "LedgerAccounts")), subtype: "updatableLedger");
            check(ledger.Nodes[0] is { Subtype: "ledgerHistory", Sublabel: "(History)" } && ledger.Nodes[0].Label.StartsWith("dbo.MSSQL_LedgerHistoryFor_", StringComparison.Ordinal) && ledger.Nodes.Count == 7,
                "an updatable ledger table's history row comes first");
            var dropped = (await client.All(Folder(db, "droppedLedgerTables"))).Nodes;
            check(dropped.Count == 1 && dropped[0] is { Subtype: "droppedLedger", Icon: "trash", Sublabel: null } && dropped[0].Label.StartsWith("dbo.MSSQL_DroppedLedgerTable_LedgerDropped_", StringComparison.Ordinal)
                && (await client.All(Folder(db, "droppedLedgerViews"))).Nodes.Count == 1, "dropped ledger tables and views have their own folders");
            check((await client.All(Folder(db, "views"), filter: Schema("dbo"))).Nodes.Any(node => node is { Label: "dbo.LedgerAccounts_Ledger", Subtype: "ledger", Icon: "verified" }), "ledger views carry the ledger icon");
        }
        if (major >= 17)
            check((await Labels(Table("dbo", "Embeddings"), "columns")).SequenceEqual(["Id (PK, int, not null)", "Embedding (vector(3), null)", "Document (json, null)"]), "vector and json columns");

        // Paging 2,500 tables in pages of 2,000 and 7: the case-sensitive keyset never repeats or skips a row.
        var bulkNames = Enumerable.Range(0, 2500).Select(i => "bulk.t" + i.ToString("0000")).ToList();
        foreach (var size in new[] { 2000, 7 })
        {
            var paged = await client.All(Folder(db, "tables"), size, Schema("bulk"));
            var rows = paged.Nodes.Where(node => node.Ref.Type == "object").Select(node => node.Label).ToList();
            check(paged.Error is null && rows.SequenceEqual(bulkNames) && paged.Total == paged.Nodes.Count, "2,500 tables page correctly at " + size + " a page (" + paged.Pages + " pages)");
        }
        var single = (await client.All(Folder(db, "tables"), 1, Schema("dbo"))).Nodes.Where(node => node.Ref.Type == "object").Select(Show).ToList();
        check(single.SequenceEqual(dboTables), "pages of one row follow the case-sensitive order (a, A, b) without duplicates");

        // Filters: LIKE metacharacters are literal; equals is case-sensitive here; creation dates are server local days.
        Task<List<string>> Filtered(ExplorerFilterDto filter) => client.All(Folder(db, "tables"), filter: filter).ContinueWith(task => task.Result.Nodes.Where(node => node.Ref.Type == "object").Select(node => node.Label).ToList());
        var today = (await sql("SELECT CONVERT(char(10), GETDATE(), 23);", "master")).Scalar!;
        check((await Filtered(new(Name: new("contains", "50%_")))).SequenceEqual(["dbo.50%_off"]) && (await Filtered(new(Name: new("contains", "[x")))).SequenceEqual(["dbo.[x]"])
            && (await Filtered(new(Name: new("equals", "a"), Schema: new("equals", "dbo")))).SequenceEqual(["dbo.a"])
            && (await Filtered(new(Name: new("notContains", "t"), Schema: new("equals", "bulk")))).Count == 0
            && (await Filtered(new(Created: new("between", today, today), Schema: new("equals", "Sales")))).SequenceEqual(["Sales.Customers", "Sales.Invoices", "Sales.Orders"])
            && (await Filtered(new(Created: new("lessThan", today), Schema: new("equals", "Sales")))).Count == 0
            && (await Filtered(new(Owner: new("equals", "dbo"), Name: new("equals", "b")))).SequenceEqual(["dbo.b"]), "text, date and owner filters, combined with AND");
        var lastDay = new List<string>();
        foreach (var (op, second, expect) in new[] { ("equals", (string?)null, 0), ("lessThan", null, 3), ("lessOrEqual", null, 3), ("greaterThan", null, 0), ("greaterOrEqual", null, 0),
            ("between", "9999-12-31", 3), ("notBetween", "9999-12-31", 0) })
        {
            var range = await client.All(Folder(db, "tables"), filter: new(Created: second is null ? new(op, "9999-12-31") : new(op, "2000-01-01", second), Schema: new("equals", "Sales")));
            var count = range.Nodes.Count(node => node.Ref.Type == "object");
            if (range.Error is not null || count != expect) lastDay.Add(op + ": " + (range.Error?.Message ?? count + " rows"));
        }
        check(lastDay.Count == 0, "every date operator accepts 9999-12-31 without overflowing: " + string.Join("; ", lastDay));

        // A dropped table's folders report NOT_FOUND with refresh-parent.
        await sql("DROP TABLE dbo.Doomed;", dbName);
        check((await client.Children(Folder(Table("dbo", "Doomed"), "columns"))).Error is { Code: "NOT_FOUND", Action: "refreshParent" }, "after DROP TABLE its Columns are NOT_FOUND");

        // An uncommitted CREATE TABLE never holds the tree for long.
        var blocker = Guid.NewGuid().ToString();
        var opened = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
            new QueryArgs(client.ConnectionId, blocker, dbName, "BEGIN TRANSACTION; CREATE TABLE dbo.VariaBlocker (id int);", Guid.NewGuid().ToString(), 10, 30), json), json);
        try
        {
            var blocked = Stopwatch.StartNew();
            var page = await client.Children(Folder(db, "tables"), filter: Schema("dbo"));
            check(opened.Status == "completed" && (page.Error is null || page.Error.Code == "BLOCKED") && blocked.ElapsedMilliseconds < 6500,
                "a folder blocked by uncommitted DDL completes or reports BLOCKED within 6.5 s (" + blocked.ElapsedMilliseconds + " ms, " + (page.Error?.Code ?? "completed") + ")");
        }
        finally
        {
            await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(new QueryArgs(client.ConnectionId, blocker, dbName, "ROLLBACK;", Guid.NewGuid().ToString(), 10, 30), json), json);
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(blocker), json), json);
        }

        service.Explorer.Options.ForcePerDatabaseScope = true;
        var perDatabase = await Labels(db, "tables", Schema("Sales"));
        service.Explorer.Options.ForcePerDatabaseScope = false;
        check(perDatabase.Contains("Sales.Orders"), "the per-database strategy reads the scratch database too");

        if (scratch.Login is { } login)
        {
            var reader = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master") with
            {
                Authentication = "sql", Username = login, Password = scratch.Password
            }, json), json);
            try
            {
                var limited = new Client(service, reader.Id, json);
                var listed = (await limited.All(Folder(Server, "databases"))).Nodes.Where(node => node.Label.StartsWith(scratch.Name, StringComparison.Ordinal)).ToList();
                var readOnly = listed.SingleOrDefault(node => node.Label == scratch.ReadOnly);
                check(readOnly is { Status: "noAccess", HasChildren: true } && (await limited.Children(Object(Database(scratch.ReadOnly)))).Error?.Code == "NO_DB_ACCESS",
                    "a database the login cannot open is listed with noAccess, and expanding it explains why");
                var visible = (await limited.All(Folder(db, "tables"))).Nodes.Where(node => node.Ref.Type == "object").ToList();
                check(visible.Count == 2500 && visible.All(node => node.Label.StartsWith("bulk.", StringComparison.Ordinal)), "a low-privilege login sees only the tables it may read");
                var audits = await limited.Children(Folder(Server, "audits"));
                check(audits.Error is null ? audits.Nodes.Count == 0 : audits.Error.Code == "PERMISSION_DENIED", "Audits is empty or PERMISSION_DENIED for a low-privilege login, never an exception");
            }
            finally { await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(reader.Id), json), json); }
        }
        else Console.WriteLine("Low-privilege Object Explorer checks skipped: the server accepts Windows logins only.");
    }
}
