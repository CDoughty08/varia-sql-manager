using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Offline SSIS Catalog checks (PR S1b): the embedded catalogue against Object Explorer's, every SsisSql statement and
/// every SSIS tree listing against the SSIS lint, which itself catches what it exists for, prologues, error mapping, request
/// validation, parameter binding, value formatting, revisions, the SSIS tree's own connection and its empty-folder rows, and
/// the service's gates and cancellation with a fake host; and for PR S-A, ssis.execute: its verbs, write templates and their
/// lint, validation, Stop Operation's refusals, and the action service's refusals before connecting, gates and Stop.</summary>
internal static class SsisChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };

    public static async Task RunAsync(Action<bool, string> check)
    {
        Catalog(check);
        Lint(check);
        Errors(check);
        Values(check);
        await ValidationAsync(check);
        await TreeAsync(check);
        await GatesAsync(check);
        await SsisActionChecks.RunAsync(check);
        await SsisCreateChecks.RunAsync(check);
    }

    private static void Catalog(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        var explorer = ExplorerCatalog.Current;
        check(catalog.CatalogDatabase == "SSISDB" && catalog.Views.SequenceEqual(["catalog", "folder", "project", "package", "environment"])
            && catalog.Views.All(view => explorer.Kind(catalog.KindOf(view)!) is { } kind && kind.Scope.StartsWith("ssis", StringComparison.Ordinal))
            && catalog.KindOf("run") is null, "the embedded SSIS catalogue loads, and each view describes one of Object Explorer's SSIS kinds");
        check(catalog.Features.SequenceEqual(SsisFeatures.Names) && catalog.Limit("packageName") == explorer.KindOf("ssisPackage").MaxName && catalog.Limit("name") == ExplorerRefs.MaxIdentifier,
            "the profile's feature names and the name bounds are the catalogue's");
        check(SsisErrors.Numbers.Keys.All(code => catalog.ErrorCodes.Contains(code)) && catalog.ErrorCodes.Contains("SQL_ERROR") && catalog.ErrorCodes.Contains("NOT_FOUND")
            && catalog.ErrorCodes.Contains("NOT_SUPPORTED") && catalog.ErrorCodes.Contains("AUTH_ENTRA") && !catalog.Retryable("CATALOG_MISSING") && catalog.Retryable("BLOCKED")
            && catalog.Retryable("DATABASE_UNAVAILABLE") && !catalog.Retryable("NO_DB_ACCESS"),
            "every code the error mapping and the service answer is in the catalogue, with its retryability");
        check(catalog.OperationStatuses[7] == "Succeeded" && catalog.OperationTypes[200] == "Create and start execution" && catalog.OperationTypes[102] == "Export project" && catalog.LoggingLevels[100] == "Custom"
            && catalog.ParameterObjectTypes[20] == "Project" && catalog.MessageTypes[120] == "Error", "the code tables label rows as SSMS does");
    }

    private static void Lint(Action<bool, string> check)
    {
        var problems = new List<string>();
        var renders = 0;
        foreach (var (id, text, list) in SsisSql.All(SsisCatalog.Current.Views))
        {
            renders++;
            problems.AddRange(SsisSql.Lint(text, list).Select(problem => id + ": " + problem));
        }
        check(renders > 1500 && problems.Count == 0, "every SsisSql statement renders for bands 13-17 and every feature set and passes the SSIS lint (" + renders + " renders"
            + (problems.Count > 0 ? "; first problem: " + problems[0] : ")"));
        // Every statement that lists rows is bounded on its own: a view's lists are marked, and a statement that orders rows is one.
        var render = new SsisRender(ExplorerCatalog.MaxBand, SsisFeatures.From([true, true, true, true, true, true]));
        var lists = SsisCatalog.Current.Views.ToDictionary(view => view, view => SsisSql.Statements(view, render).Count(statement => statement.List));
        var unmarked = SsisCatalog.Current.Views.SelectMany(view => SsisSql.Statements(view, render).Where(statement => !statement.List && statement.Text.Contains("ORDER BY", StringComparison.OrdinalIgnoreCase))
            .Select(statement => view + ": " + statement.Text)).ToList();
        check(lists is { Count: 5 } && lists["catalog"] == 1 && lists["folder"] == 0 && lists["project"] == 3 && lists["package"] == 1 && lists["environment"] == 1 && unmarked.Count == 0
            && SsisSql.Describe("project", render) == string.Join("\n", SsisSql.Statements("project", render).Select(statement => statement.Text)),
            "each describe view marks every statement that lists rows (the catalog's properties, a project's packages, parameters and references, a package's parameters, an environment's variables), so the lint bounds each one: "
            + string.Join("; ", unmarked));
        // The tree's SSIS listings follow the same rules, in every filter shape they take.
        var tree = new List<string>();
        foreach (var id in new[] { "ssisFolders", "ssisProjects", "ssisEnvironments", "ssisPackages" })
            foreach (var shape in new FilterShape?[] { null, new("contains"), new("equals"), new("notContains") })
                for (var band = 13; band <= ExplorerCatalog.MaxBand; band++)
                    tree.AddRange(SsisSql.Lint(ExplorerQueries.All[id].Render(new SqlRender(band, false, shape ?? default)), list: true).Select(problem => id + " " + band + " " + shape + ": " + problem));
        check(tree.Count == 0 && ExplorerQueries.All.Values.Count(query => query.Scope == QueryScope.Ssis) == 4 && ExplorerQueries.All["ssisCatalogs"].Scope == QueryScope.Server
            && ExplorerQueries.All["ssisPackages"].Keyset == Keyset.Id, "the SSIS tree's listings run on the SSIS pool and pass the SSIS lint too: " + string.Join("; ", tree.Take(3)));
        // The lint catches each rule.
        string[] Problems(string text, bool list = false) => [.. SsisSql.Lint(text, list)];
        var caught = new (string Text, bool List, string Expected)[]
        {
            ("SELECT OBJECT_ID(N'catalog.folders');", false, "uses OBJECT_ID("),
            ("SELECT DB_NAME();", false, "uses DB_NAME("),
            ("SELECT COL_LENGTH(N'catalog.executions', N'executed_count');", false, "uses COL_LENGTH("),
            ("SELECT CAST(o.start_time AS datetime) FROM [catalog].[operations] AS o;", false, "converts a datetimeoffset to datetime, which drops its offset"),
            ("SELECT CONVERT(datetime, o.start_time) FROM [catalog].[operations] AS o;", false, "converts a datetimeoffset to datetime, which drops its offset"),
            ("SELECT TRY_CONVERT(datetime, f.created_time) FROM [catalog].[folders] AS f;", false, "converts a datetimeoffset to datetime, which drops its offset"),
            ("SELECT TRY_CAST(e.created_time AS smalldatetime) FROM [catalog].[environments] AS e;", false, "converts a datetimeoffset to datetime, which drops its offset"),
            ("EXEC sp_executesql @stmt;", false, "runs dynamic SQL"),
            ("EXEC (@stmt);", false, "runs dynamic SQL"),
            ("SELECT 1 WHERE @x = N'SYNCHRONIZED';", false, "names SYNCHRONIZED"),
            ("UPDATE [catalog].[folders] SET description = NULL;", false, "is not a read: UPDATE"),
            ("EXEC [catalog].[start_execution] @execution_id = 1;", false, "is not a read: EXEC"),
            ("SELECT f.name INTO #f FROM [catalog].[folders] AS f;", false, "is not a read: INTO"),
            ("SELECT f.name FROM [catalog].[folders] AS f WHERE f.name = N'Finance';", false, "has the literal N'Finance'"),
            ("SELECT f.name FROM [catalog].[folders] AS f ORDER BY f.name;", true, "is not a TOP (@take) listing")
        };
        var missed = caught.Where(item => !Problems(item.Text, item.List).Contains(item.Expected)).Select(item => item.Expected + " in " + item.Text).ToList();
        check(missed.Count == 0 && Problems("SELECT CONVERT(datetime2(7), o.start_time), CAST(o.end_time AS datetimeoffset(7)), TRY_CONVERT(datetime2, o.created_time) FROM [catalog].[operations] AS o;").Length == 0
            && Problems("SELECT p.created_time, p.deployed_by_name FROM [catalog].[projects] AS p;").Length == 0,
            "the SSIS lint rejects metadata built-ins, datetime conversions, dynamic SQL, SYNCHRONIZED, writes, literals and unpaged lists, and passes datetime2, datetimeoffset and column names: "
            + string.Join("; ", missed));
        check(SsisSql.ReadPrologue(false).Contains("READ UNCOMMITTED") && SsisSql.ReadPrologue(true).Contains("READ COMMITTED;") && SsisSql.ReadPrologue(true).Contains("LOCK_TIMEOUT 5000")
            && SsisSql.ReadPrologue(false).Contains("DEADLOCK_PRIORITY LOW") && SsisSql.ProfilePrologue.Contains("LOCK_TIMEOUT 1000") && SsisSql.ProfilePrologue.Contains("READ UNCOMMITTED"),
            "reads take READ COMMITTED only under RCSI, with LOCK_TIMEOUT 5000; the profile takes the live reads' 1 s");
        // IS_MEMBER waits on a pending change to a role's members (S0); a sysadmin never evaluates it.
        var roles = SsisSql.Profile[SsisSql.Profile.LastIndexOf("SELECT ", StringComparison.Ordinal)..];
        check(roles.Split("IS_MEMBER(").Length == 3 && roles.Split("CASE WHEN IS_SRVROLEMEMBER(N'sysadmin') = 1 THEN 0 ELSE ISNULL(IS_MEMBER(").Length == 3
            && !SsisSql.Profile.Contains("internal.", StringComparison.Ordinal), "the profile evaluates IS_MEMBER only for logins that are not sysadmin, and finds features in catalog views, not internal tables");
    }

    private static void Errors(Action<bool, string> check)
    {
        var codes = new (int Number, byte Severity, string Code)[]
        {
            (1222, 16, "BLOCKED"), (1205, 13, "BLOCKED"), (229, 14, "PERMISSION_DENIED"), (230, 14, "PERMISSION_DENIED"), (4060, 11, "NO_DB_ACCESS"), (916, 14, "NO_DB_ACCESS"),
            (208, 16, "CATALOG_MISSING"), (942, 14, "DATABASE_UNAVAILABLE"), (927, 14, "DATABASE_UNAVAILABLE"), (924, 14, "DATABASE_UNAVAILABLE"), (-2, 11, "TIMEOUT"), (10054, 20, "CONNECTION_LOST"), (233, 16, "CONNECTION_LOST"), (50000, 16, "SQL_ERROR"), (601, 12, "SQL_ERROR"), (27123, 16, "WINDOWS_AUTH_REQUIRED"), (27124, 16, "SQL_ERROR")
        };
        var wrong = codes.Where(item => SsisErrors.CodeOf(item.Number, item.Severity, false) != item.Code).Select(item => item.Number + " " + SsisErrors.CodeOf(item.Number, item.Severity, false)).ToList();
        check(wrong.Count == 0 && SsisErrors.CodeOf(50000, 16, broken: true) == "CONNECTION_LOST" && SsisErrors.CodeOf(1222, 20, false) == "CONNECTION_LOST",
            "SQL Server errors map to SSIS codes: 1222 and 1205 BLOCKED, 229 PERMISSION_DENIED, 4060 NO_DB_ACCESS, 208 CATALOG_MISSING, 27123 (a SQL Server login) WINDOWS_AUTH_REQUIRED; 601 is read again: " + string.Join(", ", wrong));
        // A catalog database the login could not open: gone (no row), unavailable to everyone, or closed to this login.
        check(ExplorerLabels.Unavailable(6, 0) == "Offline" && ExplorerLabels.Unavailable(1, 0) == "Restoring..." && ExplorerLabels.Unavailable(0, 1) == "Single User, in use by another session"
            && ExplorerLabels.Unavailable(0, 0) is null && ExplorerLabels.Unavailable(0, 2) is null && SsisErrors.NotAvailable("SSISDB", "Restoring...") == "Database SSISDB is not available (Restoring...). Retry when it is back online.",
            "a catalog that cannot be opened is unavailable while it is not online or single-user in use, and otherwise closed to the login");
        var long_ = SsisErrors.Create(SsisCatalog.Current, "SQL_ERROR", new string('x', 5000));
        check(long_.Message.Length == 2048 && long_.Message.EndsWith('…') && long_.Retryable && !SsisErrors.Create(SsisCatalog.Current, "NOT_FOUND", "x").Retryable, "SSIS error messages are bounded");
        var unsupported = ExplorerErrors.Create("NOT_SUPPORTED", "Integration Services Catalogs", null, 0, "The SSIS Catalog isn't supported on SQL Server on Linux.");
        check(unsupported is { Code: "NOT_SUPPORTED", Retryable: false, Action: null, Message: "The SSIS Catalog isn't supported on SQL Server on Linux." }, "a folder the server cannot have says why, without Retry");
    }

    private static void Values(Action<bool, string> check)
    {
        var offset = new DateTimeOffset(2026, 10, 21, 14, 5, 6, 789, TimeSpan.FromHours(-7)).AddTicks(1234);
        var texts = new (object? Value, string? Text)[]
        {
            (null, null), (DBNull.Value, null), ("text", "text"), (true, "True"), (false, "False"), (42, "42"), (-7L, "-7"), ((short)3, "3"), ((byte)255, "255"),
            (1.5m, "1.5"), (0.1, "0.1"), (2.5f, "2.5"), (new DateTime(2026, 1, 2, 3, 4, 5), "2026-01-02T03:04:05"), (offset, "2026-10-21T14:05:06.7891234-07:00"),
            (new byte[] { 0x0f, 0xa0 }, "0x0FA0"), (Guid.Empty, "00000000-0000-0000-0000-000000000000")
        };
        var wrong = texts.Where(item => SsisService.Variant(item.Value) != item.Text).Select(item => item.Text + " != " + SsisService.Variant(item.Value)).ToList();
        var huge = SsisService.Variant(new string('v', 5000))!;
        check(wrong.Count == 0 && huge.Length == 4000 && huge.EndsWith('…') && SsisService.Bounded(new string('v', 4001)) is { Length: 4000 } cut && cut.EndsWith('…')
            && SsisService.Bounded(new string('v', 4000)) == new string('v', 4000), "sql_variant values become invariant text, datetimeoffsets keep their offset, and a value is at most 4,000 characters, the cut ones ending in an ellipsis: "
            + string.Join("; ", wrong));
        // A describe holds at most 2,048 rows per list and about 4,000,000 bytes in all; what it leaves out sets Truncated.
        var rows = new SsisService.Budget(SsisCatalog.Current);
        var taken = Enumerable.Range(0, 2049).Count(index => rows.Take(index, 2048, 10));
        var bytes = new SsisService.Budget(SsisCatalog.Current);
        var held = Enumerable.Range(0, 1000).TakeWhile(index => bytes.Take(index % 2048, 2048, 4000)).Count();
        var fresh = new SsisService.Budget(SsisCatalog.Current);
        check(taken == 2048 && rows.Truncated && held == 4_000_000 / (64 + 2 * 4000) && bytes.Truncated && fresh.Take(0, 2048, 4000) && !fresh.Truncated,
            "a describe's lists hold at most 2,048 rows and its answer about 4,000,000 bytes, and either cut sets truncated (" + taken + " rows, " + held + " values of 4,000 characters)");
        check(SsisService.Iso(new DateTimeOffset(2026, 10, 21, 14, 5, 0, TimeSpan.Zero)) == "2026-10-21T14:05:00+00:00", "catalog times keep their offset in ISO 8601");
        var model = new SsisFolderModel("folder", 1, "Finance", null, "CONTOSO\\dba", "2026-10-21T14:05:00+00:00", 2, 1);
        var revision = SsisService.Revision(model)!;
        check(revision.Length == 64 && revision.All(Uri.IsHexDigit) && revision == SsisService.Revision(model with { }) && revision == SsisService.Revision(model with { Projects = 3, Environments = 9 })
            && revision != SsisService.Revision(model with { Description = "Changed" }) && revision != SsisService.Revision(model with { Name = "Other" }) && revision.Length <= SsisCatalog.Current.Limit("revision"),
            "a folder's revision is a SHA-256 of what a write would change: stable, the same when only its counts change, different when its name or description does");
        var parameter = new SsisParameterDto("Server", "String", true, false, "The server", "design", "live", "V", true, null);
        var project = new SsisProjectModel("project", 7, "Finance", "Loads", null, 1, "CONTOSO\\dba", "2026-10-21T14:05:00+00:00", "2026-10-01T09:00:00+00:00", 42, "N", null,
            [new("Daily.dtsx", true, null, "1.0.1")], [parameter], [new(3, "R", null, "Env", "N")], false);
        var projectRevision = SsisService.Revision(project);
        check(projectRevision is { Length: 64 } && projectRevision == SsisService.Revision(project with { ValidationStatus = "S", Validated = "2026-10-22T08:00:00+00:00", References = [new(3, "R", null, "Env", "V")] })
            && projectRevision != SsisService.Revision(project with { Parameters = [parameter with { Value = "other" }] }) && projectRevision != SsisService.Revision(project with { VersionLsn = 43 })
            && projectRevision != SsisService.Revision(project with { References = [new(3, "A", "Other", "Env", "N")] }) && SsisService.Revision(project with { Truncated = true }) is null,
            "a project's revision covers its deployment, parameter values and references but not validation, which changes without a write; a truncated answer has none, since it does not cover the rows it left out");
        var profileView = new SsisProfile("SSISDB", false, default, new SsisRoles(true, false, false), "integrated", "Windows", 17, false).View();
        var catalogModel = new SsisCatalogModel("catalog", "SSISDB", profileView, 3, [new("RETENTION_WINDOW", "365")], false);
        check(SsisService.Revision(catalogModel) == SsisService.Revision(catalogModel with { Folders = 4, Profile = profileView with { Rcsi = true } })
            && SsisService.Revision(catalogModel) != SsisService.Revision(catalogModel with { Properties = [new("RETENTION_WINDOW", "30")] }) && profileView.Roles is { Sysadmin: true, Admin: true, SsisAdmin: false },
            "the catalog's revision covers its properties, not its folder count or the connection's profile; a sysadmin's profile reads as an admin, though ssis_admin is not evaluated for one");
        check(ExplorerLabels.Deployed(new DateTimeOffset(2026, 10, 21, 14, 5, 0, TimeSpan.FromHours(2))) == "(Deployed 2026-10-21 14:05)" && ExplorerLabels.Deployed(null) is null
            && ExplorerLabels.Variables(1) == "(1 variable)" && ExplorerLabels.Variables(1200) == "(1,200 variables)", "SSIS sublabels: a project's deployment in the catalog's offset, an environment's variable count");
        var json = JsonSerializer.Serialize(new SsisDescribeResult(model, revision, 3), Json);
        check(json.StartsWith("{\"model\":{\"view\":\"folder\",\"id\":1,\"name\":\"Finance\",\"createdBy\":", StringComparison.Ordinal) && !json.Contains("null", StringComparison.Ordinal)
            && json.Contains("\"revision\":\"" + revision + "\"", StringComparison.Ordinal), "a describe answer serializes its model by its runtime type, without null members");
    }

    /// <summary>A host whose connections never reach a server: <see cref="Hold"/> keeps opens waiting until released.</summary>
    internal sealed class FakeHost(int major = 16, bool linux = false, string auth = "integrated", int edition = 3) : ISsisHost
    {
        public SemaphoreSlim? Hold { get; set; }
        public int Opens;
        /// <summary>Writes' own connections asked for, and the catalog database each named.</summary>
        public int ActionConnections;
        public string? ActionCatalog;
        public ServerProfile Profile(string connectionId) => new(major, major + ".0.1.1", edition, "sa", false, true, false, ExplorerCatalog.MinBand, linux);
        public SqlConnection SsisConnection(string connectionId, string catalogDatabase) => new("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false;Initial Catalog=" + catalogDatabase);
        public SqlConnection SsisActionConnection(string connectionId, string catalogDatabase)
        {
            Interlocked.Increment(ref ActionConnections);
            ActionCatalog = catalogDatabase;
            return new("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false;Initial Catalog=" + catalogDatabase);
        }
        public SqlConnection SsisServerConnection(string connectionId) => new("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        public async Task OpenAsync(SqlConnection connection, CancellationToken token)
        {
            Interlocked.Increment(ref Opens);
            if (Hold is { } hold) await hold.WaitAsync(token);
            throw new RequestException("AUTH_KERBEROS", "The Kerberos ticket has expired. Run kinit, then retry.");
        }
        public string Authentication(string connectionId) => auth;
    }

    private static SsisDescribeArgs Args(string view, ObjectRefDto target, string? connectionId = null) => new(connectionId ?? Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), view, target);

    private static async Task ValidationAsync(Action<bool, string> check)
    {
        using var service = new SsisService(new FakeHost());
        string Code(SsisDescribeArgs args)
        {
            try { service.Validate(args); return "ok"; }
            catch (RequestException error) { return error.Code; }
        }
        var catalog = new ObjectRefDto("ssisCatalog", Name: "SSISDB");
        var folder = new ObjectRefDto("ssisFolder", Name: "Fin]ance' --");
        var package = new ObjectRefDto("ssisPackage", Name: new string('p', 260), SsisFolder: "Finance", SsisProject: "Loads");
        var cases = new (SsisDescribeArgs Args, string Expected)[]
        {
            (Args("catalog", catalog), "ok"), (Args("catalog", catalog with { Name = "ssisdb" }), "ok"), (Args("folder", folder), "ok"), (Args("package", package), "ok"),
            (Args("environment", new ObjectRefDto("ssisEnvironment", Name: " ", SsisFolder: "Finance")), "ok"),
            (Args("catalog", catalog with { Name = "master" }), "INVALID_PARAMS"), (Args("folder", catalog), "INVALID_PARAMS"), (Args("run", folder), "INVALID_PARAMS"),
            (Args("package", package with { Name = new string('p', 261) }), "INVALID_PARAMS"), (Args("package", package with { SsisProject = null }), "INVALID_PARAMS"),
            (Args("project", new ObjectRefDto("ssisProject", Name: "Loads", SsisFolder: new string('f', 129))), "INVALID_PARAMS"),
            (Args("folder", folder with { Database = "db" }), "INVALID_PARAMS"), (Args("folder", folder with { Name = "a\0b" }), "INVALID_PARAMS"),
            (Args("folder", folder) with { ConnectionId = "x" }, "INVALID_PARAMS"), (Args("folder", folder) with { RequestId = "y" }, "INVALID_PARAMS")
        };
        var wrong = cases.Where(item => Code(item.Args) != item.Expected).Select(item => item.Args.View + " " + JsonSerializer.Serialize(item.Args.Target, Json) + " " + Code(item.Args)).ToList();
        check(wrong.Count == 0, "ssis.describe accepts each view's own kind with names verbatim, a package name of 260, and the catalog by its name only: " + string.Join("; ", wrong));
        var profile = new SsisProfile("SSISDB", false, default, new SsisRoles(false, true, false), "sql", "Windows", 16, false);
        var bound = service.Bind("package", package, profile);
        static object? Value(SqlParameter[] parameters, string name) => parameters.Single(parameter => parameter.ParameterName == name).Value;
        check(bound.Select(parameter => parameter.ParameterName).SequenceEqual(["@folder", "@project", "@name", "@take", "@chars", "@admin"]) && Value(bound, "@folder") is "Finance"
            && Value(bound, "@project") is "Loads" && Value(bound, "@name") is string name && name.Length == 260 && Value(bound, "@take") is 2049 && Value(bound, "@chars") is 4000 && Value(bound, "@admin") is true
            && Value(service.Bind("folder", folder, profile), "@folder") is "Fin]ance' --" && Value(service.Bind("project", new ObjectRefDto("ssisProject", Name: "Loads", SsisFolder: "F"), profile), "@project") is "Loads",
            "a describe binds the target's names as parameters, verbatim, the package name up to 260");
        try { service.Bind("package", package with { Name = new string('p', 261) }, profile); check(false, "an over-long name is bound"); }
        catch (InvalidOperationException) { check(true, "a name longer than its parameter is refused rather than cut by SqlClient"); }

        using (var sql = new SqlService())
        {
            async Task<string> Dispatch(string body)
            {
                try { await sql.DispatchAsync("ssis.describe", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
                catch (RequestException error) { return error.Code; }
                catch (JsonException) { return "JSON"; }
            }
            var ids = "\"connectionId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"" + Guid.NewGuid() + "\"";
            var codes = new[]
            {
                await Dispatch("{" + ids + ",\"view\":\"folder\",\"target\":{\"kind\":\"ssisFolder\",\"name\":\"Finance\"}}"),
                await Dispatch("{" + ids + ",\"view\":\"folder\",\"target\":{\"kind\":\"ssisProject\",\"name\":\"Finance\",\"ssisFolder\":\"F\"}}"),
                await Dispatch("{" + ids + ",\"view\":\"folder\",\"target\":{\"kind\":\"ssisFolder\",\"name\":\"Finance\"},\"extra\":1}")
            };
            check(sql.LaneOf("ssis.describe") == RequestLane.Ssis && sql.Methods.Contains("ssis.describe") && SqlService.MethodNames.Contains("ssis.describe")
                && codes.SequenceEqual(["NOT_CONNECTED", "INVALID_PARAMS", "JSON"]), "ssis.describe runs on the ssis lane, rejects unknown members, and checks its target before the connection: " + string.Join(", ", codes));
        }
    }

    private static async Task TreeAsync(Action<bool, string> check)
    {
        // Linux and Azure SQL Database cannot list a catalog they do not have: the empty folder says why.
        var query = ExplorerQueries.All["ssisCatalogs"];
        var catalog = ExplorerCatalog.Current;
        ExplorerError? Empty(ExplorerProfile profile) => query.WhenEmpty!(new RowContext(catalog, profile, null, new ObjectRefDto("server")));
        check(Empty(new ExplorerProfile(16, false)) is null && Empty(new ExplorerProfile(16, false, true)) is { Code: "NOT_SUPPORTED", Retryable: false } linux && linux.Message.Contains("Linux", StringComparison.Ordinal)
            && Empty(new ExplorerProfile(16, true)) is { Code: "NOT_SUPPORTED" } cloud && cloud.Message.Contains("SSISDB or master", StringComparison.Ordinal),
            "an empty Integration Services Catalogs folder is empty on Windows, and says why on Linux and Azure SQL Database");
        check(new ServerProfile(16, null, 3, null, false, false, false, 16, Linux: true).Explorer(catalog) == new ExplorerProfile(16, false, true)
            && ServerProfile.ProbeSql.Contains("SERVERPROPERTY('PathSeparator')", StringComparison.Ordinal), "the server profile says whether SQL Server runs on Linux (PathSeparator, 2017 and later)");
        var text = ExplorerQueries.All["ssisPackages"].Render(new SqlRender(17));
        check(text.StartsWith("DECLARE @owner_id bigint;\nSELECT @owner_id = p.project_id FROM [catalog].[projects] AS p JOIN [catalog].[folders] AS f ON f.folder_id = p.folder_id WHERE f.name = @ssis_folder AND p.name = @object_name;\n"
                + "SELECT CONVERT(bit, CASE WHEN @owner_id IS NULL THEN 0 ELSE 1 END);\nIF @owner_id IS NULL RETURN;\n", StringComparison.Ordinal)
            && text.EndsWith("WHERE pk.project_id = @owner_id AND (@kb IS NULL OR pk.package_id > @kb) ORDER BY pk.package_id;", StringComparison.Ordinal)
            && ExplorerQueries.All["ssisCatalogs"].Render(new SqlRender(13)).Contains("WHERE d.name = @ssis_catalog AND (@k1 IS NULL OR d.name > @k1)", StringComparison.Ordinal),
            "a project's packages resolve the project by folder and name first and page by package_id; the catalog row is SSISDB's by parameter");

        // SSIS listings open the SSIS read pool, never the Object Explorer pool; the catalog node must name the catalog.
        var host = new ExplorerHostFake();
        using var service = new ExplorerService(host);
        var projects = await service.ChildrenAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new NodeRefDto("folder", Owner: new ObjectRefDto("ssisFolder", Name: "Finance"), Folder: "ssisProjects")),
            CancellationToken.None);
        var folders = await service.ChildrenAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new NodeRefDto("object", new ObjectRefDto("ssisCatalog", Name: "SSISDB"))), CancellationToken.None);
        var statics = await service.ChildrenAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new NodeRefDto("object", new ObjectRefDto("ssisProject", Name: "Loads", SsisFolder: "Finance"))),
            CancellationToken.None);
        check(projects.Error is { Code: "AUTH_KERBEROS" } && folders.Error is not null && host.Ssis == 2 && host.Explorer == 0
            && statics.Nodes.Select(node => node.Ref.Folder).SequenceEqual(["ssisPackages"]) && statics.Nodes[0].Ref.Owner is { Kind: "ssisProject", SsisFolder: "Finance" } && host.Ssis == 2,
            "SSIS listings open the SSIS read pool and none other; an SSIS project's Packages folder needs no SQL");
        try
        {
            await service.ChildrenAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new NodeRefDto("object", new ObjectRefDto("ssisCatalog", Name: "master"))), CancellationToken.None);
            check(false, "a catalog node of another database is browsed");
        }
        catch (RequestException error) { check(error.Code == "INVALID_PARAMS" && host.Ssis == 2, "a catalog node must name the SSIS Catalog's database"); }
        var old = await new ExplorerService(new ExplorerHostFake(12)).ChildrenAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new NodeRefDto("object", new ObjectRefDto("server"))), CancellationToken.None);
        check(!old.Nodes.Any(node => node.Ref.Folder == "integrationServicesCatalogs"), "SQL Server 2014 and earlier show no Integration Services Catalogs folder");
    }

    /// <summary>An Object Explorer host that counts which pool each listing asks for; neither reaches a server.</summary>
    private sealed class ExplorerHostFake(int major = 16) : IExplorerHost
    {
        public int Explorer, Ssis;
        public ServerProfile Profile(string connectionId) => new(major, null, 3, "sa", false, true, false);
        public SqlConnection Connection(string connectionId, string? database) { Interlocked.Increment(ref Explorer); return new("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false"); }
        public SqlConnection SsisConnection(string connectionId) { Interlocked.Increment(ref Ssis); return new("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false"); }
        public string SsisCatalog => "SSISDB";
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => throw new RequestException("AUTH_KERBEROS", "The Kerberos ticket has expired.");
    }

    private static async Task GatesAsync(Action<bool, string> check)
    {
        var folder = new ObjectRefDto("ssisFolder", Name: "Finance");
        // Versions and platforms without a catalog answer at once, with no connection.
        var old = new FakeHost(12);
        using (var service = new SsisService(old))
        {
            var answer = await service.DescribeAsync(Args("folder", folder), CancellationToken.None);
            var linux = await new SsisService(new FakeHost(17, linux: true)).DescribeAsync(Args("folder", folder), CancellationToken.None);
            check(answer.Error is { Code: "NOT_SUPPORTED", Retryable: false } && linux.Error?.Message == "The SSIS Catalog isn't supported on SQL Server on Linux." && old.Opens == 0 && answer.Model is null,
                "a server older than 2016, or on Linux, has no SSIS Catalog to read");
            // The fake catalog's checks describe on CI's Linux engine through the internal option, which reaches the connection.
            var linuxHost = new FakeHost(17, linux: true);
            var ignored = await new SsisService(linuxHost, new SsisOptions { IgnoreLinuxHost = true }).DescribeAsync(Args("folder", folder), CancellationToken.None);
            check(ignored.Error is { Code: "AUTH_KERBEROS" } && linuxHost.Opens == 1, "the internal IgnoreLinuxHost option lets the fake catalog be described on SQL Server on Linux: " + ignored.Error?.Code);
        }
        // Sign-in failures are values; two reads per connection at once, the third waits and answers BUSY.
        var host = new FakeHost { Hold = new SemaphoreSlim(0) };
        using (var service = new SsisService(host, new SsisOptions { GateWait = TimeSpan.FromMilliseconds(300) }))
        {
            var connection = Guid.NewGuid().ToString();
            var held = new[] { service.DescribeAsync(Args("folder", folder, connection), CancellationToken.None), service.DescribeAsync(Args("folder", folder, connection), CancellationToken.None) };
            var watch = Stopwatch.StartNew();
            while (host.Opens < 2 && watch.ElapsedMilliseconds < 5000) await Task.Delay(10);
            string busy;
            try { await service.DescribeAsync(Args("folder", folder, connection), CancellationToken.None); busy = "answered"; }
            catch (RequestException error) { busy = error.Code; }
            // Another connection has its own gate.
            var other = service.DescribeAsync(Args("folder", folder), CancellationToken.None);
            while (host.Opens < 3 && watch.ElapsedMilliseconds < 5000) await Task.Delay(10);
            host.Hold.Release(3);
            var answers = await Task.WhenAll([.. held, other]);
            check(busy == "BUSY" && host.Opens == 3 && answers.All(answer => answer.Error is { Code: "AUTH_KERBEROS", Retryable: true } && answer.Model is null) && service.RunningCount == 0,
                "SSIS reads take two gates per connection; a third waits, then answers BUSY; a sign-in failure is a value, and every gate comes back");
            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            var before = host.Opens;
            try { await service.DescribeAsync(Args("folder", folder, connection), cancelled.Token); check(false, "a cancelled describe runs"); }
            catch (OperationCanceledException) { check(host.Opens == before && service.RunningCount == 0, "a describe cancelled before it runs takes no gate and opens nothing"); }
            var waiting = service.DescribeAsync(Args("folder", folder, connection), CancellationToken.None);
            while (host.Opens == before && watch.ElapsedMilliseconds < 10_000) await Task.Delay(10);
            service.Forget(connection);
            try { await waiting; check(false, "a disconnected describe answers"); }
            catch (RequestException error) { check(error.Code == "CANCELLED" && service.RunningCount == 0, "a disconnect cancels the connection's describes"); }
        }
    }
}
