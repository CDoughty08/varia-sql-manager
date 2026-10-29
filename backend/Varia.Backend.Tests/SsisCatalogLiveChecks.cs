using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Explorer;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR S1b against the fake SSIS catalog (VARIA_TEST_SQL_SCRATCH=1), which the backend reaches through
/// its internal SsisOptions.CatalogDatabase: the Object Explorer SSIS tree (folders, projects, packages by package_id,
/// environments, filters, a vanished owner and a missing catalog), ssis.describe for every view with hostile names and
/// sensitive values, the profile's features, roles and isolation, the read path's bounds, lock, timeout and cancellation
/// behaviour, a catalog database that is offline or closed to the login, with a low-privilege SQL Server login for the role
/// checks. It runs on SQL Server on Linux too (CI): the describe path's Linux gate is lifted by the internal
/// SsisOptions.IgnoreLinuxHost, and what the tree says without a catalog follows the server's platform. Nothing here claims
/// real SSIS behaviour.</summary>
internal static class SsisCatalogLiveChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Dump(object? value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";

    // Names that break out of strings, brackets, comments and LIKE patterns, used verbatim end to end.
    private const string Hostile = "F]in'an\"ce -- /*";
    private const string Wildcards = "50%_off [x]";
    private const string Project = "Loads] '; DROP TABLE x; --";
    private static readonly string LongPackage = new string('P', 251) + "x.dtsx'] ";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json,
        ScratchDatabase scratch, string db, Func<string, string, string?, Task<SqlRun>> sql, Func<string, Task<object>> close)
    {
        async Task<SqlRun> Exec(string text, string? session = null)
        {
            var result = await sql(text, db, session);
            if (result.Status != "completed") throw new InvalidOperationException("SSIS tree fixture step failed: " + result.Error);
            return result;
        }
        var options = service.Ssis.Options;
        var linux = ((ISsisHost)service).Profile(info.Id).Linux;
        try
        {
            options.CatalogDatabase = db;
            options.IgnoreLinuxHost = true;
            await SeedAsync(Exec);
            await TreeAsync(check, service, info, db, linux, Exec);
            await DescribeAsync(check, service, info, db, linux, Exec, sql, close);
            await LowPrivilegeAsync(check, service, live, json, scratch, db, Exec, sql, close);
            await UnavailableAsync(check, service, info, db, sql);
        }
        finally
        {
            options.CatalogDatabase = SsisCatalog.Current.CatalogDatabase;
            options.IgnoreLinuxHost = false;
            options.TestDelay = null;
            options.Budget = new SsisOptions().Budget;
            service.Ssis.Forget(info.Id);
            service.ClearPoolsFor(info.Id, db);
        }
    }

    private static async Task SeedAsync(Func<string, string?, Task<SqlRun>> exec)
    {
        Task<SqlRun> Exec(string text) => exec(text, null);
        await Exec("EXEC [catalog].[varia_fake_seed] " + Literal(Hostile) + ", " + Literal(Project) + ", N'Daily.dtsx';\n"
            + "EXEC [catalog].[varia_fake_seed] " + Literal(Hostile) + ", " + Literal(Project) + ", N'Child.dtsx', @entry_point = 0;\n"
            + "EXEC [catalog].[varia_fake_seed] " + Literal(Hostile) + ", " + Literal(Project) + ", " + Literal(LongPackage) + ";\n"
            + "EXEC [catalog].[varia_fake_seed] " + Literal(Wildcards) + ", N'a%b', N'One.dtsx';\n"
            + "EXEC [catalog].[varia_fake_seed] " + Literal(Wildcards) + ", N'axb', N'One.dtsx';");
        await Exec("DECLARE @folder bigint = (SELECT folder_id FROM [catalog].[folders] WHERE name = " + Literal(Hostile) + ");\n"
            + "DECLARE @project bigint = (SELECT project_id FROM [catalog].[projects] WHERE folder_id = @folder AND name = " + Literal(Project) + ");\n"
            + "UPDATE [catalog].[folders] SET description = N'Hostile folder' WHERE folder_id = @folder;\n"
            + "UPDATE [catalog].[projects] SET description = N'Loads project' WHERE project_id = @project;\n"
            + "INSERT [catalog].[environments] (name, folder_id, description, created_by_sid, created_by_name, created_time) VALUES (N'Env]', @folder, N'Test environment', SUSER_SID(), SUSER_SNAME(), SYSDATETIMEOFFSET());\n"
            + "DECLARE @environment bigint = SCOPE_IDENTITY();\n"
            + "INSERT [catalog].[environment_variables] (environment_id, name, description, type, sensitive, value) VALUES (@environment, N'Port', N'A number', N'Int32', 0, CONVERT(int, 42)), "
            + "(@environment, N'Secret', NULL, N'String', 1, CONVERT(sql_variant, N'do not show'));\n"
            + "INSERT [catalog].[object_parameters] (project_id, object_type, object_name, parameter_name, data_type, required, sensitive, description, design_default_value, default_value, value_type, value_set, referenced_variable_name, validation_status) VALUES "
            + "(@project, 20, " + Literal(Project) + ", N'Server', N'String', 1, 0, N'The server', CONVERT(sql_variant, N'design'), CONVERT(sql_variant, N'live'), 'V', 1, NULL, 'N'), "
            + "(@project, 20, " + Literal(Project) + ", N'Password', N'String', 0, 1, NULL, CONVERT(sql_variant, N'hidden design'), CONVERT(sql_variant, N'hidden live'), 'V', 1, NULL, 'N'), "
            + "(@project, 20, " + Literal(Project) + ", N'When', N'DateTime', 0, 0, NULL, CONVERT(sql_variant, CONVERT(datetimeoffset(7), '2026-10-21T14:05:06.5+02:00')), NULL, 'R', 0, N'Port', 'N'), "
            + "(@project, 30, N'Daily.dtsx', N'Rows', N'Int64', 0, 0, NULL, CONVERT(sql_variant, CONVERT(bigint, 9000000000)), NULL, 'V', 0, NULL, 'N'), "
            // A parameter of another package with the same name must not show up for Daily.dtsx.
            + "(@project, 30, N'Child.dtsx', N'Rows', N'Int64', 0, 0, NULL, NULL, NULL, 'V', 0, NULL, 'N');\n"
            + "INSERT [catalog].[environment_references] (project_id, reference_type, environment_folder_name, environment_name, validation_status) VALUES (@project, 'R', NULL, N'Env]', 'N');\n"
            + "IF NOT EXISTS (SELECT 1 FROM [catalog].[catalog_properties] WHERE property_name = N'SCHEMA_VERSION') INSERT [catalog].[catalog_properties] (property_name, property_value) VALUES (N'SCHEMA_VERSION', N'8'), (N'RETENTION_WINDOW', N'365');\n"
            // A value one character past the 4,000-character bound, and one exactly at it.
            + "INSERT [catalog].[catalog_properties] (property_name, property_value) VALUES (N'VARIA_LONG', REPLICATE(CONVERT(nvarchar(max), N'v'), 4001)), (N'VARIA_EXACT', REPLICATE(CONVERT(nvarchar(max), N'w'), 4000));");
    }

    private static ExplorerChildrenArgs Args(string connectionId, NodeRefDto node, string? cursor = null, int? pageSize = null, ExplorerFilterDto? filter = null) =>
        new(connectionId, Guid.NewGuid().ToString(), node, Cursor: cursor, PageSize: pageSize, Filter: filter);
    private static NodeRefDto Object(ObjectRefDto value) => new("object", value);
    private static NodeRefDto Folder(ObjectRefDto owner, string folder) => new("folder", Owner: owner, Folder: folder);

    private static async Task TreeAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, string db, bool linux, Func<string, string?, Task<SqlRun>> exec)
    {
        Task<ExplorerChildrenResult> Children(NodeRefDto node, string? cursor = null, int? pageSize = null, ExplorerFilterDto? filter = null) =>
            service.Explorer.ChildrenAsync(Args(info.Id, node, cursor, pageSize, filter), CancellationToken.None);
        var server = new ObjectRefDto("server");
        var catalogs = await Children(Folder(server, "integrationServicesCatalogs"));
        var catalog = catalogs.Nodes.SingleOrDefault();
        check(catalogs.Error is null && catalogs.Nodes.Count == 1 && catalog is { Label: var label, Icon: "database", HasChildren: true, Ref.Object.Kind: "ssisCatalog" } && label == db && catalog.Ref.Object!.Name == db,
            "Integration Services Catalogs lists the catalog's database as the SSIS catalog (the fake one, by the internal option)");
        var folders = await Children(Object(catalog!.Ref.Object!));
        var hostile = folders.Nodes.SingleOrDefault(node => node.Label == Hostile);
        check(folders.Error is null && hostile is { Icon: "folder-library", HasChildren: true, Detail: "Hostile folder", Created: not null, Ref.Object: { Kind: "ssisFolder", Name: Hostile, SsisFolder: null } }
            && folders.Nodes.Any(node => node.Label == Wildcards) && folders.Nodes.All(node => node.Ref.Type == "object"), "the SSIS catalog lists its folders directly below itself, names verbatim");
        var folder = hostile!.Ref.Object!;
        var statics = await Children(Object(folder));
        check(statics.Nodes.Select(node => node.Ref.Folder).SequenceEqual(["ssisProjects", "ssisEnvironments"]) && statics.Nodes.All(node => node.Ref.Owner == folder), "an SSIS folder has Projects and Environments");
        var projects = await Children(Folder(folder, "ssisProjects"));
        var project = projects.Nodes.SingleOrDefault();
        check(projects.Error is null && projects.Total == 1 && project is { Label: Project, Icon: "project", HasChildren: true, Ref.Object: { Kind: "ssisProject", Name: Project, SsisFolder: Hostile } }
            && project.Sublabel?.StartsWith("(Deployed ", StringComparison.Ordinal) == true && project.Detail?.Contains("Loads project", StringComparison.Ordinal) == true,
            "a folder's projects carry the folder, and show when they were deployed: " + project?.Sublabel);
        var packages = new List<ExplorerNode>();
        string? cursor = null;
        var pages = 0;
        do
        {
            var page = await Children(Folder(project!.Ref.Object!, "ssisPackages"), cursor, pageSize: 1);
            if (page.Error is not null) { check(false, "an SSIS project's packages load: " + page.Error.Message); break; }
            packages.AddRange(page.Nodes);
            cursor = page.Cursor;
            pages++;
        } while (cursor is not null && pages < 10);
        check(pages == 3 && packages.Select(node => node.Label).SequenceEqual(["Daily.dtsx", "Child.dtsx", LongPackage]) && packages[0].Subtype == "entryPoint" && packages[1] is { Subtype: "child", Icon: "symbol-file" }
            && packages.All(node => node.Ref.Object is { Kind: "ssisPackage", SsisFolder: Hostile, SsisProject: Project } && !node.HasChildren) && packages[2].Ref.Object!.Name!.Length == 260,
            "a project's packages page by package_id, one per page here, including a 260-character name; a package that is not an entry point is a child (" + pages + " pages: "
            + string.Join(", ", packages.Select(node => node.Label.Length + " " + node.Subtype + " " + node.Icon)) + ")");
        var environments = await Children(Folder(folder, "ssisEnvironments"));
        check(environments.Nodes is [{ Label: "Env]", Sublabel: "(2 variables)", Icon: "symbol-variable", HasChildren: false, Ref.Object: { Kind: "ssisEnvironment", SsisFolder: Hostile } }],
            "a folder's environments show their variable count: " + Dump(environments));
        // A LIKE filter matches its wildcards literally.
        var wild = new ObjectRefDto("ssisFolder", Name: Wildcards);
        var filtered = await Children(Folder(wild, "ssisProjects"), filter: new(Name: new("contains", "%")));
        var all = await Children(Folder(wild, "ssisProjects"));
        check(filtered.Nodes.Select(node => node.Label).SequenceEqual(["a%b"]) && filtered.Total == 1 && all.Nodes.Select(node => node.Label).SequenceEqual(["a%b", "axb"]),
            "an SSIS folder's projects filter by name, with %, _ and [ matched literally: " + Dump(filtered) + Dump(all));
        var missing = await Children(Folder(new ObjectRefDto("ssisFolder", Name: "VariaMissingFolder"), "ssisProjects"));
        var missingProject = await Children(Folder(new ObjectRefDto("ssisProject", Name: "Nope", SsisFolder: Hostile), "ssisPackages"));
        check(missing.Error is { Code: "NOT_FOUND", Action: "refreshParent" } && missingProject.Error is { Code: "NOT_FOUND", Action: "refreshParent" }, "a listing below a folder or project that is gone answers NOT_FOUND: " + Dump(missing.Error) + Dump(missingProject.Error));

        // A catalog database that does not exist lists nothing on Windows (on Linux the folder says no catalog can exist there),
        // and its node answers NOT_FOUND.
        var options = service.Ssis.Options;
        var gone = db + "_gone";
        options.CatalogDatabase = gone;
        try
        {
            var none = await Children(Folder(server, "integrationServicesCatalogs"));
            var node = await Children(Object(new ObjectRefDto("ssisCatalog", Name: gone)));
            check(none.Nodes.Count == 0 && (linux ? none.Error is { Code: "NOT_SUPPORTED", Retryable: false } : none.Error is null)
                && node.Error is { Code: "NOT_FOUND", Action: "refreshParent" } && node.Error.Message.Contains(gone, StringComparison.Ordinal),
                "without a catalog the folder is empty (" + (linux ? "saying why on Linux" : "on Windows") + "), and a catalog node that outlived its database answers NOT_FOUND: " + Dump(none) + Dump(node));
            var described = await service.Ssis.DescribeAsync(new(info.Id, Guid.NewGuid().ToString(), "catalog", new ObjectRefDto("ssisCatalog", Name: gone)), CancellationToken.None);
            check(described.Error is { Code: "CATALOG_MISSING", Retryable: false } && described.Model is null, "describing a catalog whose database does not exist answers CATALOG_MISSING: " + Dump(described));
        }
        finally { options.CatalogDatabase = db; }
    }

    private static async Task DescribeAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, string db, bool linux, Func<string, string?, Task<SqlRun>> exec,
        Func<string, string, string?, Task<SqlRun>> sql, Func<string, Task<object>> close)
    {
        Task<SsisDescribeResult> Describe(string view, ObjectRefDto target, string? connectionId = null) =>
            service.Ssis.DescribeAsync(new(connectionId ?? info.Id, Guid.NewGuid().ToString(), view, target), CancellationToken.None);
        var catalogRef = new ObjectRefDto("ssisCatalog", Name: db);
        var folderRef = new ObjectRefDto("ssisFolder", Name: Hostile);
        var projectRef = new ObjectRefDto("ssisProject", Name: Project, SsisFolder: Hostile);
        var packageRef = new ObjectRefDto("ssisPackage", Name: "Daily.dtsx", SsisFolder: Hostile, SsisProject: Project);
        var environmentRef = new ObjectRefDto("ssisEnvironment", Name: "Env]", SsisFolder: Hostile);
        var auth = ((ISsisHost)service).Authentication(info.Id);

        // The fake catalog checks left RCSI on.
        service.Ssis.Forget(info.Id);
        var catalog = await Describe("catalog", catalogRef);
        var features = (catalog.Model as SsisCatalogModel)?.Profile.Features;
        check(catalog is { Error: null, Model: SsisCatalogModel { Profile: { Rcsi: true, Band: >= 13, Cloud: false } profile, Folders: >= 3 } model } && profile.Auth == auth
            && profile.HostPlatform == (linux ? "Linux" : "Windows")
            && features is { } found && found["customizedLoggingLevels"] && found["scaleOut"] && found["eventMessageGuid"] && found["executedCount"] && !found["operationLogSize"] && !found["checkSchemaVersion"]
            && profile.Roles is { Sysadmin: true, Admin: true, SsisAdmin: false, SsisLogreader: false } && model.Properties is { } properties && properties.Any(item => item is { Name: "SCHEMA_VERSION", Value: "8" })
            && properties.Single(item => item.Name == "VARIA_LONG").Value is { Length: 4000 } cut && cut.EndsWith("v…", StringComparison.Ordinal)
            && properties.Single(item => item.Name == "VARIA_EXACT").Value == new string('w', 4000) && catalog.Revision is { Length: 64 },
            "the catalog view reads the profile once (RCSI, the fake's features through its catalog views, a sysadmin's roles, " + auth + " authentication) and catalog_properties for an admin, "
            + "a value past 4,000 characters cut to 4,000 with an ellipsis: "
            + JsonSerializer.Serialize(catalog.Model ?? catalog.Error, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        var folder = await Describe("folder", folderRef);
        check(folder is { Error: null, Model: SsisFolderModel { Name: Hostile, Description: "Hostile folder", Projects: 1, Environments: 1, Created: var created } } && created.Length > 25
            && DateTimeOffset.TryParse(created, CultureInfo.InvariantCulture, out _) && folder.Revision is { Length: 64 }, "the folder view reads a hostile-named folder verbatim, with its counts and its time's offset: " + Dump(folder));
        var project = await Describe("project", projectRef);
        check(project is { Error: null, Model: SsisProjectModel { Folder: Hostile, Name: Project, Description: "Loads project", DeployedBy: { Length: > 0 }, Truncated: false } ordered }
                && ordered.Packages.Count == 3 && ordered.Packages.Single(item => item.Name == "Daily.dtsx") is { EntryPoint: true, Version: "1.0.1" } && ordered.Packages.Any(item => item.Name == LongPackage)
                && ordered.Packages.Single(item => item.Name == "Child.dtsx").EntryPoint == false
                && ordered.Parameters.Select(item => item.Name).SequenceEqual(["Password", "Server", "When"])
                && ordered.Parameters[0] is { Sensitive: true, DesignDefault: null, Value: null, Required: false }
                && ordered.Parameters[1] is { Sensitive: false, DesignDefault: "design", Value: "live", Required: true, ValueType: "V", ValueSet: true, Description: "The server" }
                && ordered.Parameters[2] is { DesignDefault: "2026-10-21T14:05:06.5+02:00", ValueType: "R", Variable: "Port" }
                && ordered.References is [{ Type: "R", Folder: null, Environment: "Env]", ValidationStatus: "N" }],
            "the project view reads its packages, parameters (a sensitive one without values, a datetimeoffset with its offset) and references: " + Dump(project));
        var package = await Describe("package", packageRef);
        check(package is { Error: null, Model: SsisPackageModel { Name: "Daily.dtsx", Folder: Hostile, Project: Project, EntryPoint: true, Version: "1.0.1", FormatVersion: 8, Parameters: [{ Name: "Rows", DesignDefault: "9000000000" }] } },
            "the package view reads the package and only its own parameters: " + Dump(package));
        var environment = await Describe("environment", environmentRef);
        check(environment is { Error: null, Model: SsisEnvironmentModel { Name: "Env]", Description: "Test environment", Variables: [{ Name: "Port", Type: "Int32", Value: "42", Sensitive: false }, { Name: "Secret", Sensitive: true, Value: null }] } }
            && !JsonSerializer.Serialize(environment, new JsonSerializerOptions(JsonSerializerDefaults.Web)).Contains("do not show", StringComparison.Ordinal),
            "the environment view reads its variables and never a sensitive value: " + Dump(environment.Model ?? environment.Error));
        var gone = await Describe("project", projectRef with { Name = "Nope" });
        var goneFolder = await Describe("folder", folderRef with { Name = "VariaMissingFolder" });
        check(gone.Error is { Code: "NOT_FOUND" } && goneFolder.Error is { Code: "NOT_FOUND" } && gone.Model is null, "describing an object that is gone answers NOT_FOUND: " + Dump(gone) + Dump(goneFolder));
        var again = await Describe("folder", folderRef);
        await exec("UPDATE [catalog].[folders] SET description = N'Changed' WHERE name = " + Literal(Hostile) + ";", null);
        var changed = await Describe("folder", folderRef);
        check(again.Revision == folder.Revision && changed.Revision is { Length: 64 } && changed.Revision != folder.Revision, "a describe's revision is stable, and changes with the object");

        // The read pool: every connection the reads left in the catalog's database is the SSIS read pool's.
        var pools = (await sql("SELECT COUNT(*), SUM(CASE WHEN s.program_name LIKE N'% - Integration Services' THEN 1 ELSE 0 END) FROM sys.dm_exec_sessions AS s WHERE s.database_id = DB_ID(" + Literal(db) + ") AND s.session_id <> @@SPID;", "master", null)).Sets[0][0];
        check(pools[0] is not ("0" or null) && pools[0] == pools[1], "SSIS reads and listings run on the SSIS read pool (\" - Integration Services\") in the catalog's database: " + string.Join("/", pools));

        // A writer's uncommitted change: under RCSI the read sees the committed row at once; READ UNCOMMITTED sees the change at once.
        async Task<(SsisDescribeResult Result, long Ms)> WhileHeld(Func<Task<SsisDescribeResult>> read)
        {
            var holder = Guid.NewGuid().ToString();
            await exec("BEGIN TRANSACTION; UPDATE [catalog].[folders] SET description = N'Uncommitted' WHERE name = " + Literal(Hostile) + ";", holder);
            try
            {
                var watch = Stopwatch.StartNew();
                var result = await read();
                return (result, watch.ElapsedMilliseconds);
            }
            finally
            {
                await sql("IF @@TRANCOUNT > 0 ROLLBACK;", db, holder);
                await close(holder);
            }
        }
        var committed = await WhileHeld(() => Describe("folder", folderRef));
        // Changing RCSI needs the database to itself: the backend's idle pool connections there go first.
        service.ClearPoolsFor(info.Id, db);
        var off = await sql("ALTER DATABASE " + Bracket(db) + " SET READ_COMMITTED_SNAPSHOT OFF WITH ROLLBACK IMMEDIATE;", "master", null);
        service.Ssis.Forget(info.Id);
        var dirty = await WhileHeld(() => Describe("folder", folderRef));
        var rcsi = await Describe("catalog", catalogRef);
        check(committed.Result.Model is SsisFolderModel { Description: "Changed" } && off.Status == "completed" && dirty.Result.Model is SsisFolderModel { Description: "Uncommitted" }
            && rcsi.Model is SsisCatalogModel { Profile.Rcsi: false },
            "a describe never waits on a writer's row: READ COMMITTED under RCSI reads the committed row, READ UNCOMMITTED without RCSI reads the change (" + committed.Ms + " ms, " + dirty.Ms + " ms; " + off.Error + ")");

        // A list past 2,048 rows: the answer holds 2,048, says it is truncated, and has no revision, because a write could not
        // compare the rows it left out; the attention that ends the statement leaves the pooled connection usable.
        await exec("DECLARE @folder bigint = (SELECT folder_id FROM [catalog].[folders] WHERE name = " + Literal(Wildcards) + ");\n"
            + "INSERT [catalog].[environments] (name, folder_id, description, created_by_sid, created_by_name, created_time) VALUES (N'Big', @folder, NULL, SUSER_SID(), SUSER_SNAME(), SYSDATETIMEOFFSET());\n"
            + "DECLARE @environment bigint = SCOPE_IDENTITY();\n"
            + "INSERT [catalog].[environment_variables] (environment_id, name, description, type, sensitive, value) SELECT TOP (2049) @environment, CONCAT(N'V', FORMAT(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)), 'D5')), NULL, N'Int32', 0, CONVERT(int, 1) "
            + "FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b;", null);
        var big = await Describe("environment", new ObjectRefDto("ssisEnvironment", Name: "Big", SsisFolder: Wildcards));
        var after = await Describe("environment", environmentRef);
        check(big is { Error: null, Revision: null, Model: SsisEnvironmentModel { Truncated: true, Variables: { Count: 2048 } variables } } && variables[^1].Name == "V02048"
            && after is { Error: null, Model: SsisEnvironmentModel { Truncated: false }, Revision.Length: 64 },
            "a describe list holds at most 2,048 rows and says it is truncated, without a revision, and the next read on the pool works: " + Dump(big.Error) + " " + (big.Model as SsisEnvironmentModel)?.Variables.Count);

        // Past its budget a describe answers TIMEOUT; a cancelled one ends at once. Each is bounded by a multiple of a describe
        // this run just measured, well under the 30 s the statement waits, and measured once more when it misses.
        var options = service.Ssis.Options;
        var reference = Stopwatch.StartNew();
        await Describe("folder", folderRef);
        var bound = LiveResultChecks.CancelBound(5000, reference.ElapsedMilliseconds);
        options.TestDelay = TimeSpan.FromSeconds(30);
        try
        {
            var (slow, timedOutMs) = await LiveResultChecks.OnceMore("an SSIS describe past its budget", 1000 + bound, item => item.Ms, async () =>
            {
                options.Budget = TimeSpan.FromSeconds(1);
                var watch = Stopwatch.StartNew();
                var result = await Describe("folder", folderRef);
                return (Result: result, Ms: watch.ElapsedMilliseconds);
            });
            options.Budget = TimeSpan.FromSeconds(40);
            var (outcome, cancelledMs) = await LiveResultChecks.OnceMore("a cancelled SSIS describe", 300 + bound, item => item.Ms, async () =>
            {
                using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
                var watch = Stopwatch.StartNew();
                string ended;
                try { await service.Ssis.DescribeAsync(new(info.Id, Guid.NewGuid().ToString(), "folder", folderRef), cancel.Token); ended = "answered"; }
                catch (Exception error) when (error is OperationCanceledException or Microsoft.Data.SqlClient.SqlException) { ended = "cancelled"; }
                return (Outcome: ended, Ms: watch.ElapsedMilliseconds);
            });
            check(slow.Error is { Code: "TIMEOUT", Retryable: true } && timedOutMs < 1000 + bound && outcome == "cancelled" && cancelledMs < 300 + bound && service.Ssis.RunningCount == 0,
                "a describe past its budget answers TIMEOUT, and a cancelled one ends without waiting for SQL Server (" + timedOutMs + " ms, " + cancelledMs + " ms, bounds " + (1000 + bound) + " and " + (300 + bound) + " ms)");
        }
        finally
        {
            options.TestDelay = null;
            options.Budget = TimeSpan.FromSeconds(40);
        }
    }

    private static async Task LowPrivilegeAsync(Action<bool, string> check, SqlService service, Func<string, ConnectOptions> live, JsonSerializerOptions json, ScratchDatabase scratch, string db,
        Func<string, string?, Task<SqlRun>> exec, Func<string, string, string?, Task<SqlRun>> sql, Func<string, Task<object>> close)
    {
        if (scratch.Login is null && !await scratch.CreateLoginAsync())
        {
            Console.WriteLine("The SSIS profile's role checks are skipped: this server accepts Windows logins only.");
            return;
        }
        var login = scratch.Login!;
        await exec("IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = " + Literal(login) + ") CREATE USER " + Bracket(login) + " FOR LOGIN " + Bracket(login) + ";\n"
            + "GRANT SELECT ON SCHEMA::[catalog] TO " + Bracket(login) + ";", null);
        var reader = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master") with
        {
            Authentication = "sql", Username = login, Password = scratch.Password
        }, json), json);
        var catalogRef = new ObjectRefDto("ssisCatalog", Name: db);
        Task<SsisDescribeResult> Describe() => service.Ssis.DescribeAsync(new(reader.Id, Guid.NewGuid().ToString(), "catalog", catalogRef), CancellationToken.None);
        try
        {
            // A login whose user may not connect to the catalog's database (as when guest is off and it has no user there) cannot
            // open it: the catalog exists, so it answers NO_DB_ACCESS, not CATALOG_MISSING or NOT_FOUND.
            await exec("REVOKE CONNECT FROM " + Bracket(login) + ";", null);
            SsisDescribeResult closed;
            ExplorerChildrenResult closedTree;
            try
            {
                closed = await Describe();
                closedTree = await service.Explorer.ChildrenAsync(Args(reader.Id, Object(catalogRef)), CancellationToken.None);
            }
            finally { await exec("GRANT CONNECT TO " + Bracket(login) + ";", null); }
            check(closed.Error is { Code: "NO_DB_ACCESS", Retryable: false } && closed.Error.Message.Contains(db, StringComparison.Ordinal) && closedTree.Error is { Code: "NO_DB_ACCESS", Retryable: false },
                "a login that may not open the catalog's database answers NO_DB_ACCESS for a describe and for the catalog's folders: " + Dump(closed.Error) + Dump(closedTree.Error));
            var listed = await service.Explorer.ChildrenAsync(Args(reader.Id, Folder(new ObjectRefDto("server"), "integrationServicesCatalogs")), CancellationToken.None);
            check(listed.Nodes is [{ Status: null, HasChildren: true }] && listed.Nodes[0].Label == db, "a login with a user in the catalog's database sees the catalog in the tree");
            // IS_MEMBER waits on a pending change to a role's members even under READ UNCOMMITTED (S0): the profile answers BLOCKED.
            // The pool's connection is opened first: a new login into the database waits on such a change too, bounded only by
            // the connect timeout (CONNECTION_LOST), while a pooled connection is reused without one.
            var warm = await Describe();
            service.Ssis.Forget(reader.Id);
            await exec("IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'varia_ssis_role_hold') CREATE USER [varia_ssis_role_hold] WITHOUT LOGIN;", null);
            var holder = Guid.NewGuid().ToString();
            await exec("BEGIN TRANSACTION; ALTER ROLE [ssis_admin] ADD MEMBER [varia_ssis_role_hold];", holder);
            SsisDescribeResult blocked;
            long blockedMs;
            try
            {
                var watch = Stopwatch.StartNew();
                blocked = await Describe();
                blockedMs = watch.ElapsedMilliseconds;
            }
            finally
            {
                await sql("IF @@TRANCOUNT > 0 ROLLBACK;", db, holder);
                await close(holder);
            }
            check(warm.Model is SsisCatalogModel && blocked.Error is { Code: "BLOCKED", Retryable: true } && blocked.Model is null && service.Ssis.CachedProfile(reader.Id) is null,
                "while another session changes ssis_admin's members, a login that is not sysadmin reads its profile under the 1 s lock timeout and answers BLOCKED, caching nothing (" + blockedMs + " ms): " + Dump(blocked));
            var plain = await Describe();
            check(plain.Model is SsisCatalogModel { Profile: { Auth: "sql", Roles: { Sysadmin: false, SsisAdmin: false, SsisLogreader: false } }, Properties: null },
                "once the change ends, the profile reads: SQL Server authentication, no SSIS roles, and no catalog_properties for a login that is not ssis_admin: " + Dump(plain));
            await exec("ALTER ROLE [ssis_logreader] ADD MEMBER " + Bracket(login) + "; ALTER ROLE [ssis_admin] ADD MEMBER " + Bracket(login) + ";", null);
            service.Ssis.Forget(reader.Id);
            var admin = await Describe();
            check(admin.Model is SsisCatalogModel { Profile.Roles: { Sysadmin: false, SsisAdmin: true, SsisLogreader: true }, Properties: { Count: > 0 } },
                "a member of ssis_admin and ssis_logreader reads as one, and reads catalog_properties: " + Dump(admin));
        }
        finally
        {
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(reader.Id), json), json);
            await exec("IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = " + Literal(login) + ") BEGIN ALTER ROLE [ssis_admin] DROP MEMBER " + Bracket(login) + "; ALTER ROLE [ssis_logreader] DROP MEMBER " + Bracket(login) + "; END", null);
        }
    }

    /// <summary>A catalog database that exists but no one can open (offline here; restoring and single-user in use alike) answers
    /// DATABASE_UNAVAILABLE, which a retry can clear, never NO_DB_ACCESS: the login's access is not the problem.</summary>
    private static async Task UnavailableAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, string db, Func<string, string, string?, Task<SqlRun>> sql)
    {
        // Taking the database offline needs it to itself: the backend's idle pool connections there go first.
        service.ClearPoolsFor(info.Id, db);
        var off = await sql("ALTER DATABASE " + Bracket(db) + " SET OFFLINE WITH ROLLBACK IMMEDIATE;", "master", null);
        try
        {
            service.Ssis.Forget(info.Id);
            var described = await service.Ssis.DescribeAsync(new(info.Id, Guid.NewGuid().ToString(), "folder", new ObjectRefDto("ssisFolder", Name: Hostile)), CancellationToken.None);
            var projects = await service.Explorer.ChildrenAsync(Args(info.Id, Folder(new ObjectRefDto("ssisFolder", Name: Hostile), "ssisProjects")), CancellationToken.None);
            var catalogs = await service.Explorer.ChildrenAsync(Args(info.Id, Folder(new ObjectRefDto("server"), "integrationServicesCatalogs")), CancellationToken.None);
            check(off.Status == "completed" && described.Error is { Code: "DATABASE_UNAVAILABLE", Retryable: true } && described.Error.Message.Contains("(Offline)", StringComparison.Ordinal)
                && projects.Error is { Code: "DATABASE_UNAVAILABLE", Retryable: true } && projects.Error.Message.Contains("Offline", StringComparison.Ordinal)
                && catalogs.Nodes is [{ Status: "unavailable", HasChildren: false }],
                "an offline catalog database answers DATABASE_UNAVAILABLE (retryable, naming its state) for a describe and a listing, and its row is unavailable: "
                + off.Error + Dump(described.Error) + Dump(projects.Error) + Dump(catalogs.Nodes.Select(node => node.Status)));
        }
        finally
        {
            var on = await sql("ALTER DATABASE " + Bracket(db) + " SET ONLINE;", "master", null);
            service.Ssis.Forget(info.Id);
            if (on.Status != "completed") throw new InvalidOperationException("The fake catalog could not be brought back online: " + on.Error);
        }
    }
}
