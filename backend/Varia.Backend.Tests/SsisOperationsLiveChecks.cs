using System.Globalization;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR S3, the ssis.operations live source, against the fake SSIS catalog (VARIA_TEST_SQL_SCRATCH=1), which
/// the backend reaches through its internal SsisOptions.CatalogDatabase: the window newest first in the catalog's own words and
/// tones, its pool and isolation, a new execution appearing, one that starts and is stopped (through ssis.execute) turning
/// Running, then Stopping with its stopper, then Canceled, the tiles' counts, args that read the window again under new filters
/// (kinds, statuses, a folder whose name holds LIKE's wildcards, by prefix), READ COMMITTED under READ_COMMITTED_SNAPSHOT, and a
/// catalog that does not exist ending the view CATALOG_MISSING. Nothing here claims real SSIS behaviour: no package runs.</summary>
internal static class SsisOperationsLiveChecks
{
    private const string Probe = "ssis.operations.list";
    private const string Folder = "VariaOps%_[1]";
    private const string Other = "VariaOpsX";

    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, string db,
        Func<string, string, string?, Task<SqlRun>> sql)
    {
        async Task<SqlRun> Exec(string text)
        {
            var result = await sql(text, db, null);
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
        var options = service.Ssis.Options;
        var sqlAuth = ((ISsisHost)service).Authentication(info.Id) == "sql";
        var live = new LiveService(service);
        uint next = 9700;
        (Task<LiveEnd> Task, LiveRecorder Recorder, string Id) Subscribe(object? args = null)
        {
            var recorder = new LiveRecorder(++next);
            var id = Guid.NewGuid().ToString();
            JsonElement? element = args is null ? null : JsonSerializer.SerializeToElement(args, json);
            return (live.SubscribeAsync(new LiveSubscribeArgs(id, info.Id, LiveService.SsisOperationsSource, [new LiveProbeArgs(Probe, 1000)], element), recorder.Context, json), recorder, id);
        }
        static async Task<LiveEnd> Stop((Task<LiveEnd> Task, LiveRecorder Recorder, string Id) view)
        {
            view.Recorder.Context.Cancel(CancelReason.User);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(15));
            view.Recorder.Dispose();
            return end;
        }
        LiveSample? Latest(LiveRecorder recorder) => recorder.Ticks.Select(tick => tick.Samples.FirstOrDefault(sample => sample.Probe == Probe)).LastOrDefault(sample => sample?.Tables is { Count: > 0 });
        List<string?[]> Rows(LiveRecorder recorder) => Latest(recorder) is { Tables: [var table] } ? LiveResultChecks.RowsOf(live.Store, table.Descriptor) : [];
        string?[]? RowOf(LiveRecorder recorder, long id) => Rows(recorder).FirstOrDefault(row => row[0] == id.ToString(CultureInfo.InvariantCulture));
        Task<bool> Until(LiveRecorder recorder, Func<List<string?[]>, bool> condition, int ms = 20_000) => recorder.WaitAsync(_ => condition(Rows(recorder)), ms);
        try
        {
            options.CatalogDatabase = db;
            options.IgnoreLinuxHost = true;
            options.IgnoreSqlAuthentication = sqlAuth;
            service.ClearPoolsFor(info.Id, db);
            var rcsi = await sql("ALTER DATABASE " + Bracket(db) + " SET READ_COMMITTED_SNAPSHOT OFF WITH ROLLBACK IMMEDIATE;", "master", null);
            if (rcsi.Status != "completed") throw new InvalidOperationException("RCSI could not be turned off on the fake catalog: " + rcsi.Error);
            await Exec("EXEC [catalog].[varia_fake_seed] " + Literal(Folder) + ", N'Project', N'Package.dtsx'; EXEC [catalog].[varia_fake_seed] " + Literal(Other) + ", N'Project', N'Package.dtsx';");
            var created = await Execution(Folder, start: false);
            var failed = await Execution(Folder, start: true);
            await Exec("EXEC [catalog].[varia_fake_finish] " + failed + ", 4;");
            var other = await Execution(Other, start: true);

            var view = Subscribe();
            try
            {
                var first = await Until(view.Recorder, rows => rows.Any(row => row[0] == other.ToString(CultureInfo.InvariantCulture)));
                var rows = Rows(view.Recorder);
                var ids = rows.Select(row => long.Parse(row[0]!, CultureInfo.InvariantCulture)).ToList();
                var failedRow = RowOf(view.Recorder, failed);
                check(first && view.Recorder.Opened is { Isolation: "readUncommitted", Spid: > 0, Probes: [{ State: "ok" }] } && ids.SequenceEqual(ids.OrderDescending())
                    && failedRow is [_, "Create and start execution", "Failed", Folder, "Project", "Package.dtsx", _, { } start, { } end, { } duration, _, null, _, _, "error"]
                    && start.Length == 34 && start[27] == ' ' && end.Length == 34 && duration.Contains(':', StringComparison.Ordinal)
                    && RowOf(view.Recorder, created) is [_, _, "Created", .., "muted"] && RowOf(view.Recorder, other) is [_, _, "Running", Other, .., "running"],
                    "ssis.operations shows the fake catalog's operations newest first on the SSIS pool at READ UNCOMMITTED, each in the catalog's words (type, status, folder, project, "
                    + "package), its times with their offset, its duration, and its tone (failed error, created muted, running running): " + string.Join(" | ", rows.Take(4).Select(row => string.Join(",", row))));
                var metrics = Latest(view.Recorder)?.Metrics;
                check(metrics is [>= 1, _, >= 1, _, _] && Latest(view.Recorder)?.Status is [{ Id: "newest" } newest] && Convert.ToInt64(newest.Value, CultureInfo.InvariantCulture) == ids.Max(),
                    "the tiles count running operations and the last 24 hours' failures, and the sample names the newest operation: " + string.Join(",", metrics ?? []));

                // A new execution appears; started, it is Running; Stop Operation makes it Stopping with its stopper; ended, Canceled.
                var running = await Execution(Folder, start: false);
                check(await Until(view.Recorder, rows => RowOf(view.Recorder, running) is [_, _, "Created", ..]), "a new execution appears in the window within a few samples");
                await Exec("EXEC [catalog].[start_execution] @execution_id = " + running + ";");
                check(await Until(view.Recorder, rows => RowOf(view.Recorder, running) is [_, _, "Running", .., "running"]), "an open operation read again turns Running");
                var stop = await service.SsisActions.ExecuteAsync(new(info.Id, Guid.NewGuid().ToString(), new SsisActionDto("stopOperation", running)), CancellationToken.None);
                check(stop.Error is null && await Until(view.Recorder, rows => RowOf(view.Recorder, running) is [_, _, "Stopping", .., { } stopper, _, _, "warning"] && stopper.Length > 0),
                    "Stop Operation through ssis.execute shows the operation Stopping, toned warning, with who stopped it: " + string.Join(",", RowOf(view.Recorder, running) ?? []));
                await Exec("EXEC [catalog].[varia_fake_finish] " + running + ", 3;");
                check(await Until(view.Recorder, rows => RowOf(view.Recorder, running) is [_, _, "Canceled", .., "muted"]), "the stopped operation ends Canceled, muted");

                // New args read the window again: Failed only, then the folder whose name holds LIKE's wildcards, by its prefix.
                live.Update(new LiveUpdateArgs(view.Id, LiveService.SsisOperationsSource, Args: JsonSerializer.SerializeToElement(new { statuses = new[] { 4 } }, json)), json);
                check(await Until(view.Recorder, rows => rows.Count > 0 && rows.All(row => row[2] == "Failed") && rows.Any(row => row[0] == failed.ToString(CultureInfo.InvariantCulture))),
                    "a status filter reads the window again with only its statuses: " + string.Join(" | ", Rows(view.Recorder).Select(row => row[0] + " " + row[2])));
                live.Update(new LiveUpdateArgs(view.Id, LiveService.SsisOperationsSource, Args: JsonSerializer.SerializeToElement(new { kinds = new[] { "execution" }, folder = "VariaOps%_[", prefix = true }, json)), json);
                check(await Until(view.Recorder, rows => rows.Count >= 3 && rows.All(row => row[3] == Folder)),
                    "a folder filter matches its text literally (LIKE's wildcards escaped) from the start, by prefix: " + string.Join(" | ", Rows(view.Recorder).Select(row => row[0] + " " + row[3])));
                live.Update(new LiveUpdateArgs(view.Id, LiveService.SsisOperationsSource, Args: JsonSerializer.SerializeToElement(new { kinds = new[] { "deploy" } }, json)), json);
                check(await view.Recorder.WaitAsync(recorder => Latest(recorder) is { Tables: [{ Descriptor.RowsAvailable: 0 }] }, 20_000), "a kind no operation has shows an empty window");
            }
            finally { await Stop(view); }

            // With READ_COMMITTED_SNAPSHOT on, the source reads committed rows (owner decision 4).
            service.ClearPoolsFor(info.Id, db);
            rcsi = await sql("ALTER DATABASE " + Bracket(db) + " SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;", "master", null);
            if (rcsi.Status != "completed") throw new InvalidOperationException("RCSI could not be turned on on the fake catalog: " + rcsi.Error);
            service.ClearPoolsFor(info.Id, db);
            var committed = Subscribe();
            try
            {
                var read = await Until(committed.Recorder, rows => rows.Count > 0);
                check(read && committed.Recorder.Opened is { Isolation: "readCommitted" } && committed.Recorder.Ticks.All(tick => tick.Errors is null),
                    "with READ_COMMITTED_SNAPSHOT on the catalog's database, ssis.operations reads committed rows");
            }
            finally { await Stop(committed); }

            // A catalog that does not exist ends the view: there is nothing to wait for.
            options.CatalogDatabase = "VariaScratch_no_such_catalog";
            var missing = Subscribe();
            var ended = await missing.Task.WaitAsync(TimeSpan.FromSeconds(30));
            missing.Recorder.Dispose();
            check(ended is { Ended: "failed", Code: "CATALOG_MISSING" }, "a catalog that does not exist ends the Operations view CATALOG_MISSING: " + ended.Ended + " " + ended.Code);
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
}
