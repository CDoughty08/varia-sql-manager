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
/// (CATALOG_MISSING, which ends the view); and, with the scratch SQL Server login, catalog_properties read only by an
/// ssis_admin (a login denied it still samples), a catalog view the login may not read and a catalog database it may not
/// open (PERMISSION_DENIED with the catalog's sentence, which ends the view). It drives its own LiveService over a copy of
/// the catalogue whose tree probe may run every second, so the checks need not wait 10 s between samples. Nothing here
/// claims real SSIS behaviour.</summary>
internal static class SsisTreeLiveChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Dump(object? value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    private static string View(string id) => id switch
    {
        "variables" => "environment_variables", "references" => "environment_references", "parameters" => "object_parameters", "properties" => "catalog_properties", _ => id
    };

    /// <summary>The live catalogue with the tree probe allowed to run every second, so the checks need not wait 10 s between samples.</summary>
    private static LiveCatalog Fast()
    {
        var current = LiveCatalog.Current;
        return LiveCatalog.Create(current.Limits, current.Probes.Values.Select(probe => probe.Id == LiveSql.CatalogProbe ? probe with { IntervalMs = probe.IntervalMs with { Min = 1000 } } : probe),
            current.Sources.Values);
    }

    /// <summary>Each fingerprinted view's row count in a catalog's database, in the catalogue's order, as this login reads it.</summary>
    private static async Task<List<long>> CountsAsync(Func<string, string, string?, Task<SqlRun>> sql, string db) =>
        (await sql(string.Join(" UNION ALL ", LiveSql.FingerprintIds.Select((id, index) => "SELECT " + index + ", COUNT_BIG(*) FROM [catalog].[" + View(id) + "]")) + " ORDER BY 1;", db, null))
            .Sets[0].Select(row => long.Parse(row[1]!, CultureInfo.InvariantCulture)).ToList();

    private static Dictionary<string, long>? Status(LiveTickEvent? tick) => tick?.Samples.FirstOrDefault()?.Status?.ToDictionary(value => value.Id, value => Convert.ToInt64(value.Value, CultureInfo.InvariantCulture));

    /// <summary>With VARIA_TEST_SSIS=1 and the catalog on the server: ssis.catalogProbe against the real SSISDB, read only (it
    /// creates, changes and drops nothing there), which the fake catalog cannot stand in for (row-level security, the internal
    /// schema behind the views, catalog_properties for admins only, real sql_variant columns, the cost of hashing every
    /// parameter). As this login: it opens, sends 16 status values whose counts are each view's own as the login reads it
    /// (catalog_properties too for a sysadmin), and two samples agree; its cost is reported. A login that is not an admin is
    /// not checked here: mapping one into SSISDB would change the catalog.</summary>
    public static async Task RealAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, Func<string, string, string?, Task<SqlRun>> sql)
    {
        var db = service.Ssis.Options.CatalogDatabase;
        using var live = new LiveService(service, Fast());
        var recorder = new LiveRecorder(9400);
        var task = live.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), info.Id, "ssis.catalog", [new LiveProbeArgs(LiveSql.CatalogProbe, 2000)]), recorder.Context, json);
        try
        {
            var sampled = await recorder.WaitAsync(view => view.Ticks.Count(tick => tick.Samples.Count > 0) >= 2 || view.Ticks.Any(tick => tick.Errors is not null) || task.IsCompleted, 60_000);
            var samples = recorder.Ticks.Where(tick => tick.Samples.Count > 0).ToList();
            var errors = recorder.Ticks.SelectMany(tick => tick.Errors ?? []).ToList();
            var first = Status(samples.FirstOrDefault());
            var counts = await CountsAsync(sql, db);
            var sysadmin = (await sql("SELECT IS_SRVROLEMEMBER(N'sysadmin');", "master", null)).Scalar == "1";
            Console.WriteLine("ssis.catalogProbe on " + db + ": " + string.Join(", ", samples.Select(tick => tick.Samples[0].CostMs + " ms")) + " per sample, counts "
                + string.Join(",", counts) + (sysadmin ? "." : " (the login is not sysadmin, so catalog_properties is not compared)."));
            check(sampled && errors.Count == 0 && samples.Count >= 2 && recorder.Opened is { Source: "ssis.catalog", Spid: > 0, Probes: [{ State: "ok" }] } && first is { Count: 16 }
                && LiveSql.FingerprintIds.Select((id, index) => first[id + "Count"] == counts[index] || id == "properties" && !sysadmin).All(match => match)
                && Status(samples[1])!.SequenceEqual(first),
                "the catalog probe samples the real " + db + " read only: 16 status values, each count the view's own row count as the login sees it, the same in two samples: "
                + Dump(first) + " vs " + string.Join(",", counts) + Dump(errors));
        }
        finally
        {
            recorder.Context.Cancel(CancelReason.User);
            await task.WaitAsync(TimeSpan.FromSeconds(15));
            recorder.Dispose();
        }
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> connect, JsonSerializerOptions json,
        ScratchDatabase scratch, string db, Func<string, string, string?, Task<SqlRun>> sql, Func<string, Task<object>> close)
    {
        var options = service.Ssis.Options;
        var current = LiveCatalog.Current;
        using var live = new LiveService(service, Fast());
        uint next = 9500;
        (Task<LiveEnd> Task, LiveRecorder Recorder) Subscribe(int intervalMs, string? connectionId = null)
        {
            var recorder = new LiveRecorder(++next);
            return (live.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), connectionId ?? info.Id, "ssis.catalog", [new LiveProbeArgs(LiveSql.CatalogProbe, intervalMs)]), recorder.Context, json), recorder);
        }
        static async Task<LiveEnd> Stop((Task<LiveEnd> Task, LiveRecorder Recorder) view)
        {
            view.Recorder.Context.Cancel(CancelReason.User);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(15));
            view.Recorder.Dispose();
            return end;
        }
        static Dictionary<string, long>? Latest(LiveRecorder recorder) => Status(recorder.Ticks.LastOrDefault(tick => tick.Samples.Count > 0));
        // Waits for a sample whose fingerprints differ from `before`, and names the status values that changed.
        static async Task<List<string>?> Changed((Task<LiveEnd>, LiveRecorder Recorder) view, Dictionary<string, long> before)
        {
            var seen = await view.Recorder.WaitAsync(recorder => Latest(recorder) is { } now && now.Any(item => before[item.Key] != item.Value), 15_000);
            return seen ? [.. Latest(view.Recorder)!.Where(item => before[item.Key] != item.Value).Select(item => item.Key)] : null;
        }
        Task<SqlRun> Exec(string text, string? session = null) => sql(text, db, session);
        // Each fingerprinted view's row count, in the catalogue's order, as a sysadmin reads it.
        Task<List<long>> Counts() => CountsAsync(sql, db);
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
            var counts = await Counts();
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

            // A login that is neither sysadmin nor ssis_admin: the scratch SQL Server login, its user granted SELECT on the catalog
            // schema (S1b). The real catalog shows catalog_properties only to ssis_admin and sysadmin, so here the login is denied it.
            if (scratch.Login is null && !await scratch.CreateLoginAsync())
                Console.WriteLine("The catalog probe's low-privilege checks are skipped: this server accepts Windows logins only.");
            else
            {
                var login = scratch.Login!;
                var user = Bracket(login);
                async Task Must(string text)
                {
                    var run = await Exec(text);
                    if (run.Status != "completed") throw new InvalidOperationException("Catalog probe fixture step failed: " + run.Error);
                }
                (Task<LiveEnd> Task, LiveRecorder Recorder) As(string connectionId)
                {
                    // Role and permission changes reach a new session: no pooled one from before them.
                    service.ClearPoolsFor(connectionId, db);
                    return Subscribe(1000, connectionId);
                }
                await Must("IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = " + Literal(login) + ") CREATE USER " + user + " FOR LOGIN " + user + ";\n"
                    + "GRANT SELECT ON SCHEMA::[catalog] TO " + user + ";\nDENY SELECT ON [catalog].[catalog_properties] TO " + user + ";");
                var reader = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(connect("master") with
                {
                    Authentication = "sql", Username = login, Password = scratch.Password
                }, json), json);
                try
                {
                    // The probe never reads catalog_properties for it: it samples every other view, and 0 for the properties.
                    var plain = As(reader.Id);
                    var read = await plain.Recorder.WaitAsync(recorder => Latest(recorder) is not null || recorder.Ticks.Any(tick => tick.Errors is not null), 15_000);
                    var status = Latest(plain.Recorder);
                    var plainErrors = plain.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).ToList();
                    var running = !plain.Task.IsCompleted;
                    await Stop(plain);
                    var expected = await Counts();
                    check(read && running && plainErrors.Count == 0 && status is { Count: 16 } && status["propertiesCount"] == 0 && status["propertiesChecksum"] == 0 && expected[^1] > 0
                        && LiveSql.FingerprintIds.SkipLast(1).Select((id, index) => status[id + "Count"] == expected[index]).All(match => match),
                        "a login that is not ssis_admin, denied catalog_properties, still samples the catalog: every other view's count, and 0 for the properties: " + Dump(status) + Dump(plainErrors));

                    // An ssis_admin reads them as a sysadmin does.
                    await Must("REVOKE SELECT ON [catalog].[catalog_properties] TO " + user + ";\nALTER ROLE [ssis_admin] ADD MEMBER " + user + ";");
                    var admin = As(reader.Id);
                    await admin.Recorder.WaitAsync(recorder => Latest(recorder) is not null || recorder.Ticks.Any(tick => tick.Errors is not null), 15_000);
                    var adminStatus = Latest(admin.Recorder);
                    await Stop(admin);
                    var sysadmin = Subscribe(1000);
                    await sysadmin.Recorder.WaitAsync(recorder => Latest(recorder) is not null, 15_000);
                    var sysadminStatus = Latest(sysadmin.Recorder);
                    await Stop(sysadmin);
                    check(adminStatus is { } member && sysadminStatus is { } owner && member["propertiesCount"] == expected[^1] && member["propertiesChecksum"] == owner["propertiesChecksum"] && owner["propertiesChecksum"] > 0,
                        "a member of ssis_admin, and a sysadmin, fingerprint catalog_properties: " + Dump(adminStatus) + Dump(sysadminStatus));

                    // A catalog view it may not read (229): PERMISSION_DENIED with the catalog's sentence, which ends the view.
                    await Must("ALTER ROLE [ssis_admin] DROP MEMBER " + user + ";\nDENY SELECT ON [catalog].[folders] TO " + user + ";");
                    var denied = As(reader.Id);
                    var deniedEnd = await denied.Task.WaitAsync(TimeSpan.FromSeconds(20));
                    var deniedError = denied.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).FirstOrDefault();
                    denied.Recorder.Dispose();
                    check(deniedError is { Code: "PERMISSION_DENIED", Number: 229, Terminal: true, Message: LiveErrors.CatalogAccessMessage } && deniedEnd is { Ended: "failed", Code: "PERMISSION_DENIED" },
                        "a catalog view the login may not read is PERMISSION_DENIED with the catalog's sentence, which ends the view: " + Dump(deniedError) + Dump(deniedEnd));

                    // A catalog database it may not open (4060, then sys.databases reads it online): PERMISSION_DENIED too.
                    await Must("REVOKE SELECT ON [catalog].[folders] TO " + user + ";\nREVOKE CONNECT FROM " + user + ";");
                    LiveEnd closedEnd;
                    LiveProbeError? closedError;
                    try
                    {
                        var closedView = As(reader.Id);
                        closedEnd = await closedView.Task.WaitAsync(TimeSpan.FromSeconds(20));
                        closedError = closedView.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).FirstOrDefault();
                        closedView.Recorder.Dispose();
                    }
                    finally { await Must("GRANT CONNECT TO " + user + ";"); }
                    check(closedError is { Code: "PERMISSION_DENIED", Number: null, Terminal: true, Message: LiveErrors.CatalogAccessMessage } && closedEnd is { Ended: "failed", Code: "PERMISSION_DENIED" }
                        && live.Gates.Busy == 0,
                        "a catalog database the login may not open is PERMISSION_DENIED with the catalog's sentence (read from sys.databases), which ends the view: " + Dump(closedError) + Dump(closedEnd));
                }
                finally
                {
                    await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(reader.Id), json), json);
                    await Exec("GRANT CONNECT TO " + user + ";\nREVOKE SELECT ON [catalog].[catalog_properties] TO " + user + ";\nREVOKE SELECT ON [catalog].[folders] TO " + user + ";\n"
                        + "IF IS_ROLEMEMBER(N'ssis_admin', " + Literal(login) + ") = 1 ALTER ROLE [ssis_admin] DROP MEMBER " + user + ";");
                }
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
