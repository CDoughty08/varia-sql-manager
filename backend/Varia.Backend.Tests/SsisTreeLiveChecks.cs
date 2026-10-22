using System.Globalization;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR S2's ssis.catalogProbe against the fake SSIS catalog (VARIA_TEST_SQL_SCRATCH=1), which the
/// backend reaches through its internal SsisOptions.CatalogDatabase: the probe's pool, database and prologue as SQL Server
/// sees its session; each fingerprint's count as the catalog's own, and a change to one view changing that view's
/// fingerprint alone (a sql_variant one second later included); no quick second sample for a probe without rates; an open
/// writer's transaction neither blocking it nor hiding the change (READ UNCOMMITTED), and READ COMMITTED once the catalog
/// has READ_COMMITTED_SNAPSHOT on; a catalog database that is offline (DATABASE_UNAVAILABLE, retried) or missing
/// (CATALOG_MISSING, which ends the view). It drives its own LiveService over a copy of the catalogue whose tree probe may
/// run every second, so the checks need not wait 10 s between samples. Nothing here claims real SSIS behaviour.</summary>
internal static class SsisTreeLiveChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Dump(object? value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, string db,
        Func<string, string, string?, Task<SqlRun>> sql, Func<string, Task<object>> close)
    {
        var options = service.Ssis.Options;
        var current = LiveCatalog.Current;
        var fast = LiveCatalog.Create(current.Limits, current.Probes.Values.Select(probe => probe.Id == LiveSql.CatalogProbe ? probe with { IntervalMs = probe.IntervalMs with { Min = 1000 } } : probe),
            current.Sources.Values);
        using var live = new LiveService(service, fast);
        uint next = 9500;
        (Task<LiveEnd> Task, LiveRecorder Recorder) Subscribe(int intervalMs)
        {
            var recorder = new LiveRecorder(++next);
            return (live.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), info.Id, "ssis.catalog", [new LiveProbeArgs(LiveSql.CatalogProbe, intervalMs)]), recorder.Context, json), recorder);
        }
        static async Task<LiveEnd> Stop((Task<LiveEnd> Task, LiveRecorder Recorder) view)
        {
            view.Recorder.Context.Cancel(CancelReason.User);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(15));
            view.Recorder.Dispose();
            return end;
        }
        static Dictionary<string, long>? Status(LiveTickEvent? tick) => tick?.Samples.FirstOrDefault()?.Status?.ToDictionary(value => value.Id, value => Convert.ToInt64(value.Value, CultureInfo.InvariantCulture));
        static Dictionary<string, long>? Latest(LiveRecorder recorder) => Status(recorder.Ticks.LastOrDefault(tick => tick.Samples.Count > 0));
        // Waits for a sample whose fingerprints differ from `before`, and names the status values that changed.
        static async Task<List<string>?> Changed((Task<LiveEnd>, LiveRecorder Recorder) view, Dictionary<string, long> before)
        {
            var seen = await view.Recorder.WaitAsync(recorder => Latest(recorder) is { } now && now.Any(item => before[item.Key] != item.Value), 15_000);
            return seen ? [.. Latest(view.Recorder)!.Where(item => before[item.Key] != item.Value).Select(item => item.Key)] : null;
        }
        Task<SqlRun> Exec(string text, string? session = null) => sql(text, db, session);
        try
        {
            options.CatalogDatabase = db;
            service.ClearPoolsFor(info.Id, db);
            var rcsi = (await sql("SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name = " + Literal(db) + ";", "master", null)).Scalar == "1";
            if (rcsi)
            {
                await sql("ALTER DATABASE " + Bracket(db) + " SET READ_COMMITTED_SNAPSHOT OFF WITH ROLLBACK IMMEDIATE;", "master", null);
                service.ClearPoolsFor(info.Id, db);
            }

            // Every fingerprint's count is the view's own row count, and the session is the SSIS pool's, in the catalog's
            // database, reading uncommitted with a 1 s lock timeout.
            var view = Subscribe(3000);
            var sampled = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count(tick => tick.Samples.Count > 0) >= 2, 20_000);
            var samples = view.Recorder.Ticks.Where(tick => tick.Samples.Count > 0).ToList();
            var opened = view.Recorder.Opened;
            var first = Status(samples.FirstOrDefault());
            var counts = (await Exec(string.Join(" UNION ALL ", LiveSql.FingerprintIds.Select((id, index) => "SELECT " + index + ", COUNT_BIG(*) FROM [catalog].[" + id switch
            {
                "variables" => "environment_variables", "references" => "environment_references", "parameters" => "object_parameters", "properties" => "catalog_properties", _ => id
            } + "]")) + " ORDER BY 1;")).Sets[0].Select(row => long.Parse(row[1]!, CultureInfo.InvariantCulture)).ToList();
            check(sampled && opened is { Source: "ssis.catalog", Isolation: "readUncommitted", Spid: > 0, Probes: [{ State: "ok" }] } && first is { Count: 16 }
                && samples[0].Samples[0] is { Gap: null, Metrics: null } && samples[0].Samples[0].Status!.Select(value => value.Id).SequenceEqual(current.Probes[LiveSql.CatalogProbe].Status)
                && LiveSql.FingerprintIds.Select((id, index) => first[id + "Count"] == counts[index]).All(match => match) && Status(samples[1])!.SequenceEqual(first),
                "the catalog probe opens on the fake catalog reading uncommitted, and sends 16 status values in the catalogue's order, each count the view's own row count, the same while nothing changes: "
                + Dump(first) + " vs " + string.Join(",", counts));
            // A probe without rates has no baseline to follow quickly: its second sample comes at its interval (3 s), not 1 s later.
            var spacing = samples.Count >= 2 ? samples[1].SampledAt - samples[0].SampledAt : 0;
            check(spacing >= 2500, "the catalog probe's second sample comes at its interval, with no quick second sample: " + spacing + " ms apart");
            var spid = opened?.Spid ?? 0;
            var session = await sql("SELECT s.program_name, DB_NAME(s.database_id), s.transaction_isolation_level, s.lock_timeout, s.deadlock_priority FROM sys.dm_exec_sessions AS s WHERE s.session_id = "
                + spid.ToString(CultureInfo.InvariantCulture) + ";", "master", null);
            var row = session.Sets is [[{ } found, ..], ..] ? found : null;
            check(row is [{ } program, { } database, "1", "1000", "-5"] && program.EndsWith(" - Integration Services", StringComparison.Ordinal) && database == db,
                "the catalog probe's session is the program name plus \" - Integration Services\", in the catalog's database, READ UNCOMMITTED, LOCK_TIMEOUT 1000 and DEADLOCK_PRIORITY LOW: " + string.Join(", ", row ?? []));
            await Stop(view);

            // One view at a time: a change to a folder's description changes the folders' checksum alone; a new variable the
            // variables' count and checksum; a variable's datetime one second later the variables' checksum (its bytes, not
            // its text, which would round it to the minute).
            view = Subscribe(1000);
            await view.Recorder.WaitAsync(recorder => Latest(recorder) is not null, 15_000);
            var before = Latest(view.Recorder) ?? [];
            await Exec("UPDATE TOP (1) [catalog].[folders] SET description = CONCAT(description, N'.');");
            var folders = await Changed(view, before);
            before = Latest(view.Recorder) ?? before;
            await Exec("INSERT [catalog].[environment_variables] (environment_id, name, description, type, sensitive, value) SELECT TOP (1) e.environment_id, N'VariaWhen', NULL, N'DateTime', 0, "
                + "CONVERT(sql_variant, CONVERT(datetime, '2026-10-22T10:00:01')) FROM [catalog].[environments] AS e ORDER BY e.environment_id;");
            var added = await Changed(view, before);
            before = Latest(view.Recorder) ?? before;
            await Exec("UPDATE [catalog].[environment_variables] SET value = CONVERT(sql_variant, CONVERT(datetime, '2026-10-22T10:00:02')) WHERE name = N'VariaWhen';");
            var second = await Changed(view, before);
            check(folders is ["foldersChecksum"] && added is ["variablesCount", "variablesChecksum"] && second is ["variablesChecksum"],
                "a change to one catalog view changes that view's fingerprint alone, a sql_variant a second later included: " + Dump(new { folders, added, second }));

            // A writer's open transaction neither blocks the probe nor hides its change, read uncommitted; its rollback undoes it.
            before = Latest(view.Recorder) ?? before;
            var writer = Guid.NewGuid().ToString();
            var open = await Exec("BEGIN TRANSACTION; UPDATE [catalog].[projects] SET description = CONCAT(description, N'!');", writer);
            var dirty = await Changed(view, before);
            var blocked = view.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).Count(error => error.Code == "BLOCKED");
            await Exec("ROLLBACK;", writer);
            await close(writer);
            var undone = await view.Recorder.WaitAsync(recorder => Latest(recorder) is { } now && now["projectsChecksum"] == before["projectsChecksum"], 15_000);
            check(open.Status == "completed" && dirty is ["projectsChecksum"] && blocked == 0 && undone,
                "an open transaction on the catalog's projects neither blocks the probe nor hides its change (READ UNCOMMITTED), and its rollback brings the fingerprint back: " + Dump(dirty) + " " + blocked);
            await Stop(view);

            // With READ_COMMITTED_SNAPSHOT on, the probe reads committed versions.
            service.ClearPoolsFor(info.Id, db);
            var on = await sql("ALTER DATABASE " + Bracket(db) + " SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;", "master", null);
            view = Subscribe(1000);
            var committed = await view.Recorder.WaitAsync(recorder => Latest(recorder) is not null, 15_000);
            var level = await sql("SELECT s.transaction_isolation_level FROM sys.dm_exec_sessions AS s WHERE s.session_id = " + (view.Recorder.Opened?.Spid ?? 0).ToString(CultureInfo.InvariantCulture) + ";", "master", null);
            check(on.Status == "completed" && committed && view.Recorder.Opened is { Isolation: "readCommitted" } && level.Scalar == "2",
                "with READ_COMMITTED_SNAPSHOT on, the catalog probe reads committed versions: " + view.Recorder.Opened?.Isolation + " " + level.Scalar);
            await Stop(view);
            service.ClearPoolsFor(info.Id, db);
            await sql("ALTER DATABASE " + Bracket(db) + " SET READ_COMMITTED_SNAPSHOT OFF WITH ROLLBACK IMMEDIATE;", "master", null);

            // An offline catalog database: a retried DATABASE_UNAVAILABLE, the view keeps running.
            service.ClearPoolsFor(info.Id, db);
            var off = await sql("ALTER DATABASE " + Bracket(db) + " SET OFFLINE WITH ROLLBACK IMMEDIATE;", "master", null);
            try
            {
                view = Subscribe(1000);
                var unavailable = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Any(tick => tick.Errors is not null), 15_000);
                var error = view.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).FirstOrDefault();
                check(off.Status == "completed" && unavailable && error is { Code: "DATABASE_UNAVAILABLE", Terminal: false } && !view.Task.IsCompleted,
                    "an offline catalog database is a DATABASE_UNAVAILABLE value the probe retries, and the view keeps running: " + off.Error + Dump(error));
                await Stop(view);
            }
            finally
            {
                var back = await sql("ALTER DATABASE " + Bracket(db) + " SET ONLINE;", "master", null);
                if (back.Status != "completed") throw new InvalidOperationException("The fake catalog could not be brought back online: " + back.Error);
            }

            // A catalog that does not exist: CATALOG_MISSING, terminal, which ends the view failed.
            options.CatalogDatabase = "VariaScratch_missing_" + Guid.NewGuid().ToString("N");
            view = Subscribe(1000);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(20));
            var missing = view.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).FirstOrDefault();
            view.Recorder.Dispose();
            check(missing is { Code: "CATALOG_MISSING", Terminal: true, Message: LiveErrors.CatalogMissingMessage } && end is { Ended: "failed", Code: "CATALOG_MISSING" } && live.Gates.Busy == 0,
                "a catalog that does not exist is CATALOG_MISSING (terminal), which ends the view failed and holds no live gate: " + Dump(missing) + Dump(end));
        }
        finally
        {
            options.CatalogDatabase = SsisCatalog.Current.CatalogDatabase;
            service.ClearPoolsFor(info.Id, db);
        }
    }
}
