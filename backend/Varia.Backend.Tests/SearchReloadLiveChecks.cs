using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Data.SqlClient;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Live SQL Server reload checks (scratch only; docs/object-search.md, Saved index): each "new session" drops the
/// connection's index and builds again on the same store. A database unchanged since its file was saved is held from the file and
/// read no further, its file not written again; a rename, and then an altered view and procedure, a new table, a dropped
/// procedure and a column added, are each read again alone; a database dropped and created again under its name is read whole;
/// auto-created statistics are never indexed; a fingerprint that fails or takes too long falls back to a whole read.</summary>
internal static class SearchReloadLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, string connectionId, Func<string, string, Task<SqlRun>> sql, string scratch)
    {
        var database = scratch + "_rl";
        string Bracket(string name) => "[" + name.Replace("]", "]]") + "]";
        var marker = "varia_reload_" + Guid.NewGuid().ToString("N")[..8];
        async Task Run(string text, string name)
        {
            var run = await sql(text, database);
            check(run.Error is null, "the reload checks " + name + ": " + run.Error);
        }
        var made = await sql("CREATE DATABASE " + Bracket(database) + ";", "master");
        check(made.Error is null, "the reload checks create their database: " + made.Error);
        var storeRoot = Directory.CreateTempSubdirectory("varia-index-reload-live-").FullName;
        var storeFolder = Path.Combine(storeRoot, IndexStoreLimits.FolderName);
        var outcomes = new System.Collections.Concurrent.ConcurrentDictionary<string, string>(StringComparer.Ordinal);
        try
        {
            await Run("CREATE SCHEMA rl;", "create their schema");
            await Run("CREATE TABLE rl.Orders (id int PRIMARY KEY, amount int, note int); CREATE TABLE rl.Old_Name (id int);"
                + " INSERT rl.Orders VALUES (1, 2, 3), (2, 3, 4); DECLARE @n int; SELECT @n = COUNT(*) FROM rl.Orders WHERE amount = 2;", "create tables and an auto-created statistic");
            await Run("CREATE VIEW rl.vw_orders AS SELECT id AS c, N'" + marker + "_one' AS v FROM rl.Orders;", "create a view");
            await Run("CREATE PROCEDURE rl.usp_keep AS SELECT N'" + marker + "_keep' AS v;", "create a procedure");
            await Run("CREATE PROCEDURE rl.usp_gone AS SELECT 2;", "create a procedure to drop");
            await Run("CREATE TRIGGER tr_rl ON DATABASE FOR CREATE_SYNONYM AS DECLARE @v nvarchar(64) = N'" + marker + "_ddl';", "create a database DDL trigger");
            var auto = await sql("SELECT COUNT(*) FROM sys.stats WHERE object_id = OBJECT_ID(N'rl.Orders') AND auto_created = 1;", database);
            check(auto.Error is null && int.TryParse(auto.Scalar, out var autos) && autos >= 1, "the server created an auto statistic on the scratch table (" + auto.Scalar + ")");

            service.Search.Store.Configure(new("encrypted", storeFolder, IndexStoreLimits.DefaultDiskMiB, Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))));
            await service.Search.Store.Idle();
            service.Search.ReloadOutcome = (name, outcome) => { if (name == database) outcomes[name] = outcome; };
            async Task<ObjectIndexResult> Session()
            {
                outcomes.Clear();
                service.Search.Forget(connectionId);
                var result = await service.Search.IndexAsync(new(connectionId, Guid.NewGuid().ToString()), CancellationToken.None);
                await service.Search.Store.Idle();
                return result;
            }
            async Task<List<string>> Names(string text) =>
                [.. service.Search.Search(new(connectionId, Guid.NewGuid().ToString(), text, false, false, false, "all", Database: database), CancellationToken.None).Hits.Select(hit => hit.Object.Kind + ":" + hit.Label)];
            var scope = service.Search.ScopeOf(connectionId, ((IObjectSearchHost)service).Profile(connectionId))!;
            byte[] FileBytes() => service.Search.Store.Find(scope, IndexUnitKind.Database, database) is { } unit ? File.ReadAllBytes(Path.Combine(storeFolder, unit.Name)) : [];

            var first = await Session();
            var savedUnit = service.Search.Store.Find(scope, IndexUnitKind.Database, database);
            check(first.Status.State == "ready" && savedUnit is not null && SqlSync.From(savedUnit.Sync) is { Definitions: true, Children: true } && !outcomes.ContainsKey(database),
                "a first session reads the database whole and saves it with its fingerprint");
            check(!(await Names("_WA_Sys_")).Any(hit => hit.Contains(":rl.", StringComparison.Ordinal)) && (await Names("PK__Orders")).Count > 0, "auto-created statistics are not indexed; the primary key's are");

            // An unchanged database: held from the file, nothing read again, the file not written again.
            var before = FileBytes();
            var counts = service.Search.SqlReloads;
            var watch = Stopwatch.StartNew();
            await Session();
            var unchangedMs = watch.ElapsedMilliseconds;
            var after = service.Search.SqlReloads;
            check(outcomes.GetValueOrDefault(database) == "unchanged" && after.Unchanged > counts.Unchanged && before.Length > 0 && before.AsSpan().SequenceEqual(FileBytes())
                && service.Search.IndexOf(connectionId)?.Get(database) is { SaveWhenHeld: false } held && held.Sync.Span.SequenceEqual(savedUnit!.Sync),
                "an unchanged database is held from its file, read no further and not saved again (" + outcomes.GetValueOrDefault(database) + ", " + unchangedMs + " ms for the session)");
            check(await Names(marker + "_keep") is ["procedure:rl.usp_keep"], "and what it holds is searchable");

            // A rename alone (its date changes too, but the row's checksum is what tells it apart either way).
            await Run("EXEC sp_rename N'rl.Old_Name', N'New_Name';", "rename a table");
            await Session();
            check(outcomes.GetValueOrDefault(database) is { } renamed && renamed.StartsWith("reread:1:", StringComparison.Ordinal)
                && (await Names("New_Name")).Contains("table:rl.New_Name") && !(await Names("Old_Name")).Any(hit => hit.StartsWith("table:rl.", StringComparison.Ordinal)),
                "a renamed table is read again alone and found by its new name (" + outcomes.GetValueOrDefault(database) + ")");
            check((await Names(marker + "_ddl")).Count == 1, "a database DDL trigger (not in sys.objects, so in no listing) keeps its definition through a selective re-read");

            // An altered view and procedure, a new table, a dropped procedure and a column added: only those are read again.
            await Run("ALTER VIEW rl.vw_orders AS SELECT id AS c, N'" + marker + "_two' AS v FROM rl.Orders;", "alter the view");
            await Run("DROP PROCEDURE rl.usp_gone; CREATE TABLE rl.Added (id int); ALTER TABLE rl.Orders ADD " + marker + "_col int;", "drop, create and alter");
            await Run("ALTER PROCEDURE rl.usp_keep AS SELECT N'" + marker + "_kept' AS v;", "alter the procedure");
            await Session();
            var outcome = outcomes.GetValueOrDefault(database) ?? "";
            var parts = outcome.Split(':');
            check(parts is ["reread", var ids, _] && int.TryParse(ids, out var reread) && reread is >= 5 and <= 12,
                "a database with a few changes reads only those objects again (" + outcome + ")");
            var two = await Names(marker + "_two");
            var kept = await Names(marker + "_kept");
            check(two is ["view:rl.vw_orders"] && (await Names(marker + "_one")).Count == 0 && kept is ["procedure:rl.usp_keep"] && (await Names(marker + "_keep")).Count == 0,
                "an altered view's and procedure's definitions are the new ones (" + string.Join(", ", two.Concat(kept)) + ")");
            check((await Names("Added")).Contains("table:rl.Added") && (await Names("usp_gone")).Count == 0 && (await Names(marker + "_col")).Any(name => name.StartsWith("column:rl.Orders.", StringComparison.Ordinal)),
                "a new table is found, a dropped procedure is gone, and an added column is under its table");
            // The merged read was saved in place, and the next session finds it unchanged.
            await Session();
            check(outcomes.GetValueOrDefault(database) == "unchanged" && await Names(marker + "_two") is ["view:rl.vw_orders"],
                "the read merged from a selective re-read was saved, and a session after it finds it unchanged (" + outcomes.GetValueOrDefault(database) + ")");

            // A statistic created on a table changes no date, but the table's row checksum.
            await Run("CREATE STATISTICS st_" + marker + " ON rl.Orders (note);", "create a statistic");
            await Session();
            check(outcomes.GetValueOrDefault(database) is { } stats && stats.StartsWith("reread:", StringComparison.Ordinal) && (await Names("st_" + marker)).Count == 1,
                "a statistic created on a table is read again with it (" + outcomes.GetValueOrDefault(database) + ")");

            // A fingerprint that fails, or takes longer than its budget: the database is read whole, as a value.
            service.Search.ReloadFingerprint = _ => "SELECT 1/0;";
            var failed = service.Search.SqlReloads.Failed;
            await Session();
            check(outcomes.GetValueOrDefault(database) == "failed" && service.Search.SqlReloads.Failed > failed && await Names(marker + "_kept") is ["procedure:rl.usp_keep"],
                "a fingerprint that fails is counted and the database read whole");
            // The whole read's own fingerprint failed too: the read was kept and saved with nothing to compare, so the next build
            // reads it whole again, now saving a fingerprint.
            check(service.Search.Store.Find(scope, IndexUnitKind.Database, database) is { Sync.Length: 0 }, "a whole read whose fingerprint failed is saved with no fingerprint");
            service.Search.ReloadFingerprint = ObjectSearchSql.Fingerprint;
            await Session();
            check(outcomes.GetValueOrDefault(database) == "unverifiable" && service.Search.Store.Find(scope, IndexUnitKind.Database, database) is { } refreshed && SqlSync.From(refreshed.Sync) is not null,
                "a file with no fingerprint is read whole, and saved with one (" + outcomes.GetValueOrDefault(database) + ")");
            service.Search.ReloadFingerprint = render => "WAITFOR DELAY '00:00:10';\n" + ObjectSearchSql.Fingerprint(render);
            service.Search.FingerprintBudget = TimeSpan.FromMilliseconds(300);
            watch.Restart();
            await Session();
            check(outcomes.GetValueOrDefault(database) == "failed" && watch.Elapsed < TimeSpan.FromSeconds(60) && await Names(marker + "_kept") is ["procedure:rl.usp_keep"],
                "a fingerprint past its budget is counted and the database read whole (" + watch.ElapsedMilliseconds + " ms)");
            service.Search.ReloadFingerprint = ObjectSearchSql.Fingerprint;
            service.Search.FingerprintBudget = TimeSpan.FromSeconds(15);
            await Session();

            // Saved with its definitions left out for memory: an unchanged fingerprint does not keep it so once there is room.
            await service.Search.Store.ClearAsync();
            await service.Search.Store.Idle();
            var reserve = service.Search.Limits.NamesReserveBytes;
            service.Search.Limits.NamesReserveBytes = service.Search.Budget.Limit;
            try { await Session(); }
            finally { service.Search.Limits.NamesReserveBytes = reserve; }
            check((await Names(marker + "_kept")).Count == 0 && service.Search.Store.Find(scope, IndexUnitKind.Database, database) is not null,
                "a read with no room for definitions is saved without them");
            await Session();
            check(outcomes.GetValueOrDefault(database) == "whole" && await Names(marker + "_kept") is ["procedure:rl.usp_keep"],
                "an unchanged database saved without its definitions is read whole once there is room for them (" + outcomes.GetValueOrDefault(database) + ")");
            await Session();
            check(outcomes.GetValueOrDefault(database) == "unchanged", "and is then held from its file (" + outcomes.GetValueOrDefault(database) + ")");

            // Dropped and created again under the same name: another database, read whole.
            SqlConnection.ClearAllPools();
            var dropped = await sql("ALTER DATABASE " + Bracket(database) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE " + Bracket(database) + "; CREATE DATABASE " + Bracket(database) + ";", "master");
            check(dropped.Error is null, "the reload checks drop their database and create it again: " + dropped.Error);
            await Run("CREATE PROCEDURE dbo.usp_reborn AS SELECT N'" + marker + "_reborn' AS v;", "create a procedure in the new database");
            await Session();
            check(outcomes.GetValueOrDefault(database) == "identity" && await Names(marker + "_reborn") is ["procedure:dbo.usp_reborn"] && (await Names(marker + "_kept")).Count == 0 && !(await Names("Added")).Contains("table:rl.Added"),
                "a database dropped and created again under its name is another database: read whole, nothing of the old one kept");

            // How long the fingerprint takes on each database the login can open, the largest (by objects) last.
            var timings = new List<(string Database, long Objects, double Ms)>();
            var render = ObjectSearchService.IndexRender(((IObjectSearchHost)service).Profile(connectionId));
            foreach (var name in (await sql("SELECT d.name FROM sys.databases AS d WHERE d.state = 0 AND d.database_id <> 2 AND HAS_DBACCESS(d.name) = 1;", "master")).Sets[0].Select(row => row[0]!))
            {
                var count = await sql("SELECT COUNT_BIG(*) FROM sys.objects;", name);
                var timed = Stopwatch.StartNew();
                var run = await sql(ObjectSearchSql.Prologue + ObjectSearchSql.Fingerprint(render), name);
                timed.Stop();
                if (run.Error is null && long.TryParse(count.Scalar, out var objects)) timings.Add((name.StartsWith("VariaScratch", StringComparison.Ordinal) ? "scratch" : name, objects, timed.Elapsed.TotalMilliseconds));
            }
            var largest = timings.OrderBy(timing => timing.Objects).LastOrDefault();
            Console.WriteLine("Fingerprint times: " + string.Join(", ", timings.OrderByDescending(timing => timing.Objects).Take(5).Select(timing => timing.Database + " " + timing.Objects + " objects " + timing.Ms.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + " ms")));
            check(timings.Count > 0 && largest.Ms < 30_000, "the fingerprint runs on every database the login can open (largest: " + largest.Objects + " objects, " + largest.Ms.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + " ms)");
        }
        finally
        {
            service.Search.ReloadOutcome = null;
            service.Search.ReloadFingerprint = ObjectSearchSql.Fingerprint;
            service.Search.FingerprintBudget = TimeSpan.FromSeconds(15);
            service.Search.Store.Configure(new("disabled", storeFolder, IndexStoreLimits.DefaultDiskMiB));
            await service.Search.Store.Idle();
            try { Directory.Delete(storeRoot, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            SqlConnection.ClearAllPools();
            await sql("IF DB_ID(N'" + database.Replace("'", "''") + "') IS NOT NULL BEGIN ALTER DATABASE " + Bracket(database) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE " + Bracket(database) + "; END", "master");
        }
    }
}
