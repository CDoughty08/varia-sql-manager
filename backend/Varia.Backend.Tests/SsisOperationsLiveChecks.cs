using System.Globalization;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR S3, the ssis.operations live source. Against the fake SSIS catalog (VARIA_TEST_SQL_SCRATCH=1), which
/// the backend reaches through its internal SsisOptions.CatalogDatabase: the window newest first in the catalog's own words and
/// tones, its pool and isolation, a new execution appearing, one that starts and is stopped (through ssis.execute) turning
/// Running, then Stopping with its stopper, then Canceled, the tiles' counts over every operation whatever the filters, args that
/// read the window again (kinds, statuses, a folder whose name holds LIKE's wildcards, by prefix, a validation's and a
/// deployment's project), the lock policy (a writer's lock on an operation never blocks the view: READ UNCOMMITTED reads through
/// it, READ COMMITTED under READ_COMMITTED_SNAPSHOT reads the committed row), 10,000 rows within the probe's budget, a catalog
/// that does not exist ending the view CATALOG_MISSING, and a login that cannot open it told so (PERMISSION_DENIED), even when it
/// cannot see the catalog's row. Nothing here claims real SSIS behaviour: no package runs. With VARIA_TEST_SSIS=1 and SSISDB,
/// <see cref="RealAsync"/> reads the real catalog's operations (no objects created).</summary>
internal static class SsisOperationsLiveChecks
{
    private const string Probe = "ssis.operations.list";
    private const string Folder = "VariaOps%_[1]";
    private const string Other = "VariaOpsX";
    private const string Validated = "VariaOpsValidated";

    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";

    /// <summary>One subscription to ssis.operations and what it recorded.</summary>
    private sealed record View(Task<LiveEnd> Task, LiveRecorder Recorder, string Id);

    private sealed class Views(LiveService live, JsonSerializerOptions json)
    {
        private uint next = 9700;

        public View Subscribe(string connectionId, object? args = null, int intervalMs = 1000)
        {
            var recorder = new LiveRecorder(++next);
            var id = Guid.NewGuid().ToString();
            JsonElement? element = args is null ? null : JsonSerializer.SerializeToElement(args, json);
            return new(live.SubscribeAsync(new LiveSubscribeArgs(id, connectionId, LiveService.SsisOperationsSource, [new LiveProbeArgs(Probe, intervalMs)], element), recorder.Context, json), recorder, id);
        }

        public void Update(View view, object args) =>
            live.Update(new LiveUpdateArgs(view.Id, LiveService.SsisOperationsSource, Args: JsonSerializer.SerializeToElement(args, json)), json);

        public static async Task<LiveEnd> Stop(View view)
        {
            view.Recorder.Context.Cancel(CancelReason.User);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(15));
            view.Recorder.Dispose();
            return end;
        }

        public static LiveSample? Latest(LiveRecorder recorder) => recorder.Ticks.Select(tick => tick.Samples.FirstOrDefault(sample => sample.Probe == Probe)).LastOrDefault(sample => sample?.Tables is { Count: > 0 });
        public List<string?[]> Rows(LiveRecorder recorder) => Latest(recorder) is { Tables: [var table] } ? LiveResultChecks.RowsOf(live.Store, table.Descriptor) : [];
        public string?[]? RowOf(LiveRecorder recorder, long id) => Rows(recorder).FirstOrDefault(row => row[0] == id.ToString(CultureInfo.InvariantCulture));
        public Task<bool> Until(LiveRecorder recorder, Func<List<string?[]>, bool> condition, int ms = 20_000) => recorder.WaitAsync(_ => condition(Rows(recorder)), ms);
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, string db,
        Func<string, string, string?, Task<SqlRun>> sql, Func<string, ConnectOptions> connect, ScratchDatabase scratch)
    {
        async Task<SqlRun> Exec(string text, string? session = null)
        {
            var result = await sql(text, db, session);
            if (result.Status != "completed") throw new InvalidOperationException("SSIS operations fixture step failed: " + result.Error);
            return result;
        }
        async Task<long> Execution(string folder, bool start)
        {
            var id = long.Parse((await Exec("DECLARE @id bigint; EXEC [catalog].[create_execution] @folder_name = " + Literal(folder) + ", @project_name = N'Project', @package_name = N'Package.dtsx', "
                + "@execution_id = @id OUTPUT; SELECT @id;")).Scalar!, CultureInfo.InvariantCulture);
            if (start) await Exec("EXEC [catalog].[start_execution] @execution_id = " + id + ";");
            return id;
        }
        async Task Rcsi(bool on)
        {
            service.ClearPoolsFor(info.Id, db);
            var result = await sql("ALTER DATABASE " + Bracket(db) + " SET READ_COMMITTED_SNAPSHOT " + (on ? "ON" : "OFF") + " WITH ROLLBACK IMMEDIATE;", "master", null);
            if (result.Status != "completed") throw new InvalidOperationException("RCSI could not be turned " + (on ? "on" : "off") + " on the fake catalog: " + result.Error);
            service.ClearPoolsFor(info.Id, db);
        }
        // A writer's open transaction on an operation's row (as the catalog's cleanup or a stop holds one), then what `during` saw.
        async Task<T> Holding<T>(long operation, Func<Task<T>> during)
        {
            var holder = Guid.NewGuid().ToString();
            await Exec("BEGIN TRANSACTION; UPDATE [catalog].[operations] SET status = 5 WHERE operation_id = " + operation + ";", holder);
            try { return await during(); }
            finally
            {
                await sql("IF @@TRANCOUNT > 0 ROLLBACK;", db, holder);
                await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(holder), json), json);
            }
        }
        // The samples that arrive while a lock is held: at least three, and how many of them carried an error.
        static async Task<(bool Kept, int Errors)> Sampling(LiveRecorder recorder)
        {
            var from = recorder.Ticks.Count;
            var kept = await recorder.WaitAsync(item => item.Ticks.Count >= from + 3, 15_000);
            return (kept, recorder.Ticks.Skip(from).Count(tick => tick.Errors is { Count: > 0 }));
        }
        var options = service.Ssis.Options;
        var sqlAuth = ((ISsisHost)service).Authentication(info.Id) == "sql";
        var live = new LiveService(service);
        var views = new Views(live, json);
        try
        {
            options.CatalogDatabase = db;
            options.IgnoreLinuxHost = true;
            options.IgnoreSqlAuthentication = sqlAuth;
            await Rcsi(on: false);
            await Exec("EXEC [catalog].[varia_fake_seed] " + Literal(Folder) + ", N'Project', N'Package.dtsx'; EXEC [catalog].[varia_fake_seed] " + Literal(Other) + ", N'Project', N'Package.dtsx';");
            var created = await Execution(Folder, start: false);
            var failed = await Execution(Folder, start: true);
            await Exec("EXEC [catalog].[varia_fake_finish] " + failed + ", 4;");
            var other = await Execution(Other, start: true);
            // A running validation of a project in Folder, and a deployment of that project: neither has an execution.
            var ids = (await Exec("INSERT INTO [catalog].[operations] (operation_type, created_time, object_type, object_name, status, start_time, caller_sid, caller_name)\n"
                + "VALUES (300, SYSDATETIMEOFFSET(), 20, " + Literal(Validated) + ", 2, SYSDATETIMEOFFSET(), SUSER_SID(), SUSER_SNAME());\n"
                + "DECLARE @validation bigint = SCOPE_IDENTITY();\n"
                + "INSERT INTO [catalog].[validations] (validation_id, environment_scope, validate_type, folder_name, project_name, operation_type, object_name, object_type, status, caller_sid, caller_name)\n"
                + "VALUES (@validation, 'D', 'F', " + Literal(Folder) + ", " + Literal(Validated) + ", 300, " + Literal(Validated) + ", 20, 2, SUSER_SID(), SUSER_SNAME());\n"
                + "INSERT INTO [catalog].[operations] (operation_type, created_time, object_type, object_name, status, start_time, end_time, caller_sid, caller_name)\n"
                + "VALUES (101, SYSDATETIMEOFFSET(), 20, " + Literal(Validated) + ", 7, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SUSER_SID(), SUSER_SNAME());\n"
                + "SELECT @validation, CONVERT(bigint, SCOPE_IDENTITY());")).Sets[0][0];
            var validation = long.Parse(ids[0]!, CultureInfo.InvariantCulture);
            var deployment = long.Parse(ids[1]!, CultureInfo.InvariantCulture);
            string Id(long value) => value.ToString(CultureInfo.InvariantCulture);

            var view = views.Subscribe(info.Id);
            try
            {
                var first = await views.Until(view.Recorder, rows => rows.Any(row => row[0] == Id(deployment)));
                var rows = views.Rows(view.Recorder);
                var order = rows.Select(row => long.Parse(row[0]!, CultureInfo.InvariantCulture)).ToList();
                var failedRow = views.RowOf(view.Recorder, failed);
                check(first && view.Recorder.Opened is { Isolation: "readUncommitted", Spid: > 0, Probes: [{ State: "ok" }] } && order.SequenceEqual(order.OrderDescending())
                    && failedRow is [_, "Create and start execution", "Failed", Folder, "Project", "Package.dtsx", _, { } start, { } end, { } duration, _, null, _, _, "error"]
                    && start.Length == 26 && start[19] == ' ' && end.Length == 26 && duration.Contains(':', StringComparison.Ordinal)
                    && views.RowOf(view.Recorder, created) is [_, _, "Created", .., "muted"] && views.RowOf(view.Recorder, other) is [_, _, "Running", Other, .., null]
                    && views.RowOf(view.Recorder, validation) is [_, "Validate project", "Running", Folder, Validated, null, Validated, ..]
                    && views.RowOf(view.Recorder, deployment) is [_, "Deploy project", "Succeeded", null, Validated, null, Validated, ..],
                    "ssis.operations shows the fake catalog's operations newest first on the SSIS pool at READ UNCOMMITTED, each in the catalog's words (type, status, folder, project, "
                    + "package; a validation's folder and project, a deployment's project), its times to the second with their offset, its duration, and its tone (failed error, created muted, "
                    + "running none): " + string.Join(" | ", rows.Take(5).Select(row => string.Join(",", row))));
                var metrics = Views.Latest(view.Recorder)?.Metrics;
                check(metrics is [>= 2, _, >= 1, _, _] && Views.Latest(view.Recorder)?.Status is [{ Id: "newest" } newest] && Convert.ToInt64(newest.Value, CultureInfo.InvariantCulture) == order.Max(),
                    "the tiles count running operations and the last 24 hours' failures, and the sample names the newest operation: " + string.Join(",", metrics ?? []));

                // The lock policy: a writer holding an operation's row never blocks the view. READ UNCOMMITTED reads through the lock,
                // so the uncommitted Pending shows, and the view keeps sampling while another request completes.
                var (readThrough, kept, errors, elsewhere) = await Holding(created, async () =>
                {
                    var through = await views.Until(view.Recorder, rows => views.RowOf(view.Recorder, created) is [_, _, "Pending", ..]);
                    var (sampling, failures) = await Sampling(view.Recorder);
                    return (through, sampling, failures, (await sql("SELECT COUNT(*) FROM [catalog].[folders];", db, null)).Status);
                });
                check(readThrough && kept && errors == 0 && elsewhere == "completed" && await views.Until(view.Recorder, rows => views.RowOf(view.Recorder, created) is [_, _, "Created", ..]),
                    "with READ_COMMITTED_SNAPSHOT off, an open writer's lock on an operation never blocks the view: it reads the uncommitted status through it at READ UNCOMMITTED and keeps "
                    + "sampling without BLOCKED, another request completes meanwhile, and the rolled-back row shows its committed status again (" + errors + " samples with errors)");

                // A new execution appears; started, it is Running; Stop Operation makes it Stopping with its stopper; ended, Canceled.
                var running = await Execution(Folder, start: false);
                check(await views.Until(view.Recorder, rows => views.RowOf(view.Recorder, running) is [_, _, "Created", ..]), "a new execution appears in the window within a few samples");
                await Exec("EXEC [catalog].[start_execution] @execution_id = " + running + ";");
                check(await views.Until(view.Recorder, rows => views.RowOf(view.Recorder, running) is [_, _, "Running", .., null]), "an open operation read again turns Running");
                var stop = await service.SsisActions.ExecuteAsync(new(info.Id, Guid.NewGuid().ToString(), new SsisActionDto("stopOperation", running)), CancellationToken.None);
                check(stop.Error is null && await views.Until(view.Recorder, rows => views.RowOf(view.Recorder, running) is [_, _, "Stopping", .., { } stopper, _, _, "warning"] && stopper.Length > 0),
                    "Stop Operation through ssis.execute shows the operation Stopping, toned warning, with who stopped it: " + string.Join(",", views.RowOf(view.Recorder, running) ?? []));
                await Exec("EXEC [catalog].[varia_fake_finish] " + running + ", 3;");
                check(await views.Until(view.Recorder, rows => views.RowOf(view.Recorder, running) is [_, _, "Canceled", .., "muted"]), "the stopped operation ends Canceled, muted");

                // New args read the window again: Failed only, then the folder whose name holds LIKE's wildcards, by its prefix.
                views.Update(view, new { statuses = new[] { 4 } });
                check(await views.Until(view.Recorder, rows => rows.Count > 0 && rows.All(row => row[2] == "Failed") && rows.Any(row => row[0] == Id(failed))),
                    "a status filter reads the window again with only its statuses: " + string.Join(" | ", views.Rows(view.Recorder).Select(row => row[0] + " " + row[2])));
                views.Update(view, new { kinds = new[] { "execution" }, folder = "VariaOps%_[", prefix = true });
                check(await views.Until(view.Recorder, rows => rows.Count >= 3 && rows.All(row => row[3] == Folder && row[1] == "Create and start execution")),
                    "a folder filter matches its text literally (LIKE's wildcards escaped) from the start, by prefix: " + string.Join(" | ", views.Rows(view.Recorder).Select(row => row[0] + " " + row[3])));
                // A project filter finds the validation (by its own project) and the deployment (by the project it deployed).
                views.Update(view, new { project = Validated });
                check(await views.Until(view.Recorder, rows => rows.Count == 2 && rows.Any(row => row[0] == Id(validation)) && rows.Any(row => row[0] == Id(deployment))),
                    "a project filter matches a validation's project and a deployment's, which have no execution: " + string.Join(" | ", views.Rows(view.Recorder).Select(row => row[0] + " " + row[1])));
                views.Update(view, new { kinds = new[] { "validation" }, folder = Folder });
                check(await views.Until(view.Recorder, rows => rows.Count == 1 && rows[0][0] == Id(validation)), "a folder filter matches a validation's folder");

                // The tiles ignore the filters: with only deployments shown, they still count every running, pending and failed operation.
                var expected = (await Exec("SELECT COUNT_BIG(CASE WHEN status = 2 THEN 1 END), COUNT_BIG(CASE WHEN status = 5 THEN 1 END),\n"
                    + "    COUNT_BIG(CASE WHEN status IN (4, 6) AND created_time >= DATEADD(hour, -24, SYSDATETIMEOFFSET()) THEN 1 END) FROM [catalog].[operations];")).Sets[0][0];
                views.Update(view, new { kinds = new[] { "deploy" } });
                var deploys = await views.Until(view.Recorder, rows => rows.Count == 1 && rows[0][0] == Id(deployment));
                var filteredMetrics = Views.Latest(view.Recorder)?.Metrics;
                check(deploys && filteredMetrics is [{ } runningCount, { } pendingCount, { } failedCount, _, _] && expected is [{ } r, { } p, { } f]
                    && runningCount == double.Parse(r, CultureInfo.InvariantCulture) && pendingCount == double.Parse(p, CultureInfo.InvariantCulture) && failedCount == double.Parse(f, CultureInfo.InvariantCulture)
                    && runningCount >= 2,
                    "with only deployments shown, Running, Pending and Failed (24 h) still count every operation the login may see: " + string.Join(",", filteredMetrics ?? []) + " against " + string.Join(",", expected));
                views.Update(view, new { caller = "VariaNobody" });
                check(await view.Recorder.WaitAsync(recorder => Views.Latest(recorder) is { Tables: [{ Descriptor.RowsAvailable: 0 }] }, 20_000), "a filter no operation passes shows an empty window");
            }
            finally { await Views.Stop(view); }

            // With READ_COMMITTED_SNAPSHOT on, the source reads committed rows (owner decision 4): a writer's lock neither blocks it nor
            // shows it the uncommitted status.
            await Rcsi(on: true);
            var committed = views.Subscribe(info.Id);
            try
            {
                var read = await views.Until(committed.Recorder, rows => views.RowOf(committed.Recorder, created) is [_, _, "Created", ..]);
                var (kept, errors, status) = await Holding(created, async () =>
                {
                    var (sampling, failures) = await Sampling(committed.Recorder);
                    return (sampling, failures, views.RowOf(committed.Recorder, created)?[2]);
                });
                check(read && committed.Recorder.Opened is { Isolation: "readCommitted" } && kept && errors == 0 && status == "Created",
                    "with READ_COMMITTED_SNAPSHOT on the catalog's database, ssis.operations reads committed rows: a writer's lock neither blocks it nor shows the uncommitted status ("
                    + status + ", " + errors + " samples with errors)");
            }
            finally { await Views.Stop(committed); }
            await Rcsi(on: false);

            await BudgetAsync(check, views, info, Exec);
            await MissingAsync(check, service, views, info, db);
            await AccessAsync(check, service, views, json, db, Exec, sql, connect, scratch);
        }
        finally
        {
            live.Dispose();
            options.CatalogDatabase = SsisCatalog.Current.CatalogDatabase;
            options.IgnoreLinuxHost = false;
            options.IgnoreSqlAuthentication = false;
            service.Ssis.Forget(info.Id);
            service.ClearPoolsFor(info.Id, db);
        }
    }

    /// <summary>10,000 operations shown (20,000 read a sample, twice the limit) within the probe's own statement budget at a 10 s
    /// interval; measured once more when the first try misses it, as other runs on the server may slow one read.</summary>
    private static async Task BudgetAsync(Action<bool, string> check, Views views, ConnectionInfo info, Func<string, string?, Task<SqlRun>> exec)
    {
        const int Rows = 10_000, IntervalMs = 10_000;
        var range = LiveCatalog.Current.Probes[Probe].Budget;
        var budget = Math.Clamp((int)(0.8 * IntervalMs), range.Min, range.Max);
        var first = long.Parse((await exec("SELECT ISNULL(MAX(operation_id), 0) FROM [catalog].[operations];", null)).Scalar!, CultureInfo.InvariantCulture);
        await exec("INSERT INTO [catalog].[operations] (operation_type, created_time, object_type, object_name, status, start_time, end_time, caller_sid, caller_name)\n"
            + "SELECT TOP (" + (2 * Rows + 500).ToString(CultureInfo.InvariantCulture) + ") 200, DATEADD(second, -CONVERT(int, ROW_NUMBER() OVER (ORDER BY (SELECT NULL))), SYSDATETIMEOFFSET()), 20, N'VariaOpsBulk', 7,\n"
            + "    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SUSER_SID(), SUSER_SNAME() FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b;", null);
        try
        {
            async Task<(bool Arrived, int CostMs, int Errors)> Measure()
            {
                var view = views.Subscribe(info.Id, new { limit = Rows }, IntervalMs);
                try
                {
                    var arrived = await view.Recorder.WaitAsync(recorder => Views.Latest(recorder) is { Tables: [{ Descriptor.RowsAvailable: Rows }] }, 60_000);
                    return (arrived, Views.Latest(view.Recorder)?.CostMs ?? -1, view.Recorder.Ticks.Count(tick => tick.Errors is { Count: > 0 }));
                }
                finally { await Views.Stop(view); }
            }
            var (arrived, cost, errors) = await LiveResultChecks.OnceMore("an Operations sample of 10,000 rows", budget, item => item.Arrived && item.Errors == 0 ? item.CostMs : long.MaxValue, Measure);
            check(arrived && errors == 0 && cost >= 0 && cost < budget,
                "an Operations window of 10,000 rows (20,000 read) arrives within the probe's statement budget of " + budget + " ms at a 10 s interval: " + cost + " ms, " + errors + " samples with errors");
            Console.WriteLine("Operations sample of 10,000 rows on the fake catalog: " + cost + " ms.");
        }
        finally { await exec("DELETE FROM [catalog].[operations] WHERE operation_id > " + first + " AND object_name = N'VariaOpsBulk';", null); }
    }

    /// <summary>A catalog that does not exist ends the view: there is nothing to wait for.</summary>
    private static async Task MissingAsync(Action<bool, string> check, SqlService service, Views views, ConnectionInfo info, string db)
    {
        var options = service.Ssis.Options;
        options.CatalogDatabase = "VariaScratch_no_such_catalog";
        try
        {
            var missing = views.Subscribe(info.Id);
            var ended = await missing.Task.WaitAsync(TimeSpan.FromSeconds(30));
            missing.Recorder.Dispose();
            check(ended is { Ended: "failed", Code: "CATALOG_MISSING" }, "a catalog that does not exist ends the Operations view CATALOG_MISSING: " + ended.Ended + " " + ended.Code);
        }
        finally { options.CatalogDatabase = db; }
    }

    /// <summary>A SQL Server login that may not open the catalog's database is told so (PERMISSION_DENIED, terminal), whether or not
    /// it sees the database's row; a missing catalog is called missing only for a login that sees every database's row, since one
    /// denied VIEW ANY DATABASE sees no row of a database it cannot open.</summary>
    private static async Task AccessAsync(Action<bool, string> check, SqlService service, Views views, JsonSerializerOptions json, string db, Func<string, string?, Task<SqlRun>> exec,
        Func<string, string, string?, Task<SqlRun>> sql, Func<string, ConnectOptions> connect, ScratchDatabase scratch)
    {
        if (scratch.Login is null && !await scratch.CreateLoginAsync())
        {
            Console.WriteLine("The Operations access checks for a login without the catalog are skipped: this server accepts Windows logins only.");
            return;
        }
        var login = scratch.Login!;
        var options = service.Ssis.Options;
        const string Gone = "VariaScratch_no_such_catalog";
        var exists = "IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = " + Literal(login) + ") ";
        await exec(exists + "DENY CONNECT TO " + Bracket(login) + ";", null);
        var reader = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(connect("master") with
        {
            Authentication = "sql", Username = login, Password = scratch.Password
        }, json), json);
        async Task<LiveEnd> End(string catalog)
        {
            options.CatalogDatabase = catalog;
            service.ClearPoolsFor(reader.Id, catalog);
            var view = views.Subscribe(reader.Id);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(30));
            view.Recorder.Dispose();
            return end;
        }
        try
        {
            var seen = await End(db);
            var missingSeen = await End(Gone);
            var denied = await sql("DENY VIEW ANY DATABASE TO " + Bracket(login) + ";", "master", null);
            if (denied.Status != "completed") throw new InvalidOperationException("VIEW ANY DATABASE could not be denied to the scratch login: " + denied.Error);
            var unseen = await End(db);
            var missingUnseen = await End(Gone);
            check(seen is { Ended: "failed", Code: "PERMISSION_DENIED" } && seen.Message == LiveErrors.CatalogAccessMessage && missingSeen is { Ended: "failed", Code: "CATALOG_MISSING" }
                && unseen is { Ended: "failed", Code: "PERMISSION_DENIED" } && missingUnseen is { Ended: "failed", Code: "PERMISSION_DENIED" } && missingUnseen.Message == LiveErrors.CatalogAccessMessage,
                "a login that may not open the catalog's database ends the view PERMISSION_DENIED, and a missing catalog is CATALOG_MISSING only for a login that sees every database's row "
                + "(denied VIEW ANY DATABASE, it cannot tell, and says it has no access): " + string.Join("; ", new[] { seen, missingSeen, unseen, missingUnseen }.Select(end => end.Ended + " " + end.Code)));
        }
        finally
        {
            options.CatalogDatabase = db;
            await sql("REVOKE VIEW ANY DATABASE FROM " + Bracket(login) + ";", "master", null);
            await exec(exists + "REVOKE CONNECT FROM " + Bracket(login) + ";\n" + exists + "GRANT CONNECT TO " + Bracket(login) + ";", null);
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(reader.Id), json), json);
        }
    }

    /// <summary>With VARIA_TEST_SSIS=1, on a server whose SSISDB exists: ssis.operations against the real catalog's views (row-level
    /// security, its real types and its joins of executions and validations by id). Its isolation follows the real catalog's
    /// READ_COMMITTED_SNAPSHOT, samples arrive without errors with the catalogue's columns and every tile, and the probe's cost is
    /// reported. It only reads: it creates nothing in SSISDB.</summary>
    public static async Task RealAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, Func<string, Task<SqlRun>> sql)
    {
        var rcsi = (await sql("SELECT CONVERT(int, is_read_committed_snapshot_on) FROM sys.databases WHERE name = N'SSISDB';")).Scalar;
        if (rcsi is null)
        {
            Console.WriteLine("SSISDB does not exist on this server: the real catalog's Operations check is skipped.");
            return;
        }
        var options = service.Ssis.Options;
        var live = new LiveService(service);
        var views = new Views(live, json);
        try
        {
            options.CatalogDatabase = SsisCatalog.Current.CatalogDatabase;
            service.ClearPoolsFor(info.Id, options.CatalogDatabase);
            var view = views.Subscribe(info.Id, new { windowHours = SsisCatalog.Current.Limit("operationsWindowHours") });
            try
            {
                var arrived = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count(tick => tick.Samples.Any(sample => sample.Probe == Probe && sample.Tables is { Count: > 0 })) >= 3, 30_000);
                var samples = view.Recorder.Ticks.SelectMany(tick => tick.Samples).Where(sample => sample.Probe == Probe).ToList();
                var errors = view.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).Select(error => error.Code).Distinct().ToList();
                var latest = Views.Latest(view.Recorder);
                check(arrived && view.Recorder.Opened?.Isolation == (rcsi == "1" ? "readCommitted" : "readUncommitted") && errors.Count == 0 && latest?.Tables?[0].Descriptor.Columns.Count == 15
                    && latest.Metrics is { Length: 5 } metrics && metrics.All(value => value is >= 0),
                    "ssis.operations reads the real SSISDB (" + latest?.Tables?[0].Descriptor.RowsAvailable + " operations in the last year) at the isolation its READ_COMMITTED_SNAPSHOT picks, "
                    + "with every column and tile: " + view.Recorder.Opened?.Isolation + ", errors " + string.Join(",", errors));
                Console.WriteLine("Operations probe on the real SSISDB: " + string.Join(", ", samples.Select(sample => sample.CostMs + " ms")) + ".");
            }
            finally { await Views.Stop(view); }
        }
        finally
        {
            live.Dispose();
            service.Ssis.Forget(info.Id);
        }
    }
}
