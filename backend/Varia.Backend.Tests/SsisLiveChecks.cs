using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace Varia.Backend.Tests;

/// <summary>Live SSIS catalog checks (D-ssis 12.2, 12.3; PR S0). With VARIA_TEST_SSIS=1: the drift check, which reads the real
/// SSISDB's shape and fails when it differs from tests/fixtures/ssisdb/manifest.json, and, with VARIA_TEST_SQL_SCRATCH=1 too,
/// the same check against the Integration Services feature's own catalog backup restored as a marked VariaScratch_…_ssisref
/// database (found from the engine's service path, so it runs before anyone has created the catalog). Neither creates,
/// changes or drops SSISDB. VARIA_UPDATE_SSIS_MANIFEST=1 rewrites the server band's manifest entry instead, from SSISDB when
/// it exists, otherwise from the backup. With VARIA_TEST_SQL_SCRATCH=1: the fake catalog in a marked VariaScratch_…_ssis
/// database, its shape against the manifest, its stubs' states and errors, the SQL Server authentication refusal, and the
/// commit-order hazard a log tail must survive, under locking READ COMMITTED, READ UNCOMMITTED and RCSI. Nothing here claims
/// real SSIS behaviour: no package runs.</summary>
internal static class SsisLiveChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static long Long(string? text) => long.Parse(text!, CultureInfo.InvariantCulture);

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        async Task<SqlRun> Sql(string text, string database = "master", string? session = null)
        {
            var id = session ?? Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { if (session is null) await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        Task<SqlRun> Run(string text, string database) => Sql(text, database);
        var scratchAllowed = Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") == "1";
        var ssis = Environment.GetEnvironmentVariable("VARIA_TEST_SSIS") == "1";
        var update = ssis && Environment.GetEnvironmentVariable("VARIA_UPDATE_SSIS_MANIFEST") == "1";
        if (!ssis && !scratchAllowed)
        {
            Console.WriteLine("SSIS catalog checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 for the fake catalog, and VARIA_TEST_SSIS=1 for the drift check against SSISDB and the catalog backup.");
            return;
        }
        var path = SsisManifest.PathOf();
        var manifest = File.Exists(path) ? SsisManifest.Parse(File.ReadAllText(path)) : null;
        var major = int.Parse((await Sql("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion'));")).Scalar!, CultureInfo.InvariantCulture);
        CatalogShape? written = null;

        if (ssis)
        {
            if ((await Sql("SELECT COUNT(*) FROM sys.databases WHERE name = N'SSISDB';")).Scalar == "1")
            {
                var real = await SsisShapeReader.ReadAsync(Run, "SSISDB", "catalog");
                Console.WriteLine("SSISDB: schema version " + real.SchemaVersion + ", build " + real.SchemaBuild + ", compatibility level " + real.Database.CompatibilityLevel
                    + ", RCSI " + (real.Database.ReadCommittedSnapshot ? "on" : "off") + ", collation " + real.Database.Collation + ".");
                if (update) written = real;
                else Drift(check, manifest, real, "the real SSISDB");
            }
            else Console.WriteLine("SSISDB does not exist on this server: the real catalog's drift check is skipped (create it in SSMS: Integration Services Catalogs, Create Catalog).");
        }
        if (!scratchAllowed)
        {
            Write(manifest, written, path);
            Console.WriteLine("SSIS catalog backup and fake catalog checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping uniquely named databases on a disposable development server.");
            return;
        }

        await using var scratch = ScratchDatabase.Bare(Run);
        if (ssis)
        {
            var engine = (await Sql("SELECT filename FROM sys.dm_server_services WHERE filename LIKE N'%sqlservr.exe%';")).Scalar;
            var backup = SsisManifest.BackupPath(engine, major);
            var header = backup is null ? null : await Sql("RESTORE HEADERONLY FROM DISK = " + Literal(backup) + ";");
            // The header's DatabaseName column, so a stray file of that name is never restored as the catalog's shape.
            if (header is { Status: "completed" } && header.Sets[0].Count == 1 && header.Sets[0][0][9] == "SSISDB")
            {
                var reference = await scratch.RestoreSsisReferenceAsync(backup!);
                var shape = await SsisShapeReader.ReadAsync(Run, reference, "backup");
                check(shape.Views.Count > 20 && shape.Procedures.ContainsKey("create_execution") && shape.SqlAuthRefused.Contains("start_execution"),
                    "the engine's service path leads to the Integration Services catalog backup " + Path.GetFileName(backup) + ", which restores under a scratch name and reads as a catalog");
                if (update) written ??= shape;
                else Drift(check, manifest, shape, "the catalog backup " + Path.GetFileName(backup));
            }
            else Console.WriteLine("No Integration Services catalog backup where the engine's service path implies (" + (backup ?? "not a Windows install") + "): the backup's drift check is skipped.");
        }
        if (update)
        {
            Write(manifest, written, path);
            Console.WriteLine("Fake catalog checks skipped while the manifest is rewritten: regenerate schema.sql (npx vitest run tests/ssisdb-fixtures.test.ts -u), then run again.");
            return;
        }
        if (manifest is null) throw new InvalidOperationException(path + " is missing.");
        await FakeAsync(check, Sql, id => service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json), scratch, manifest.Catalogs[^1]);
    }

    private static void Write(ManifestFile? manifest, CatalogShape? shape, string path)
    {
        if (shape is null) return;
        File.WriteAllText(path, SsisManifest.Write(SsisManifest.With(manifest, shape)));
        Console.WriteLine("Wrote manifest.json's band " + shape.Band + " entry from the " + shape.Source + ".");
    }

    private static void Drift(Action<bool, string> check, ManifestFile? manifest, CatalogShape actual, string what)
    {
        var expected = manifest?.Catalogs.FirstOrDefault(entry => entry.Band == actual.Band);
        if (expected is null)
        {
            Console.WriteLine("manifest.json has no band " + actual.Band + " entry, so " + what + "'s drift check is skipped. Add one with VARIA_TEST_SSIS=1 VARIA_UPDATE_SSIS_MANIFEST=1.");
            return;
        }
        var differences = SsisManifest.Compare(expected, actual);
        check(differences.Count == 0, what + " matches manifest.json's band " + actual.Band + " entry: " + actual.Views.Count + " views, " + actual.Procedures.Count + " procedures, "
            + actual.SqlAuthRefused.Count + " refusing SQL Server authentication (" + string.Join("; ", differences.Take(8)) + ")");
    }

    private static async Task FakeAsync(Action<bool, string> check, Func<string, string, string?, Task<SqlRun>> sql, Func<string, Task<object>> close,
        ScratchDatabase scratch, CatalogShape expected)
    {
        var folder = SsisManifest.Folder();
        var db = await scratch.CreateSsisAsync(expected.Database.Collation);
        async Task<SqlRun> Exec(string text, string? session = null)
        {
            var result = await sql(text, db, session);
            if (result.Status != "completed") throw new InvalidOperationException("Fake catalog step failed: " + result.Error);
            return result;
        }
        async Task<string?> Scalar(string text) => (await Exec(text)).Scalar;
        // The error number a statement raises (0 when it raises none), caught in the batch so a stub's RAISERROR is a value. It
        // is the last result: a read that fails on a lock has already sent its columns as an empty result.
        async Task<int> Error(string text) =>
            int.Parse((await Exec("BEGIN TRY\n" + text + "\nSELECT 0;\nEND TRY\nBEGIN CATCH\nSELECT ERROR_NUMBER();\nEND CATCH")).Sets[^1][0][0]!, CultureInfo.InvariantCulture);
        const string Create = "DECLARE @id bigint; EXEC [catalog].[create_execution] @folder_name = N'VariaFake', @project_name = N'Project', @package_name = {0}, @execution_id = @id OUTPUT;";
        async Task<long> Execution(bool start)
        {
            var id = Long(await Scalar(string.Format(CultureInfo.InvariantCulture, Create, "N'Package.dtsx'") + " SELECT @id;"));
            if (start) check(await Error("EXEC [catalog].[start_execution] @execution_id = " + id + ";") == 0, "the fake starts a created execution");
            return id;
        }

        // The stubs, like the real procedures, refuse a caller whose sid is a SQL-type database user's. The catalog's dbo is
        // sa (sid 0x01 in the backup), which matches no Windows caller; the fake's dbo is made sa too, or its creator would match.
        var owner = await sql("DECLARE @sql nvarchar(max) = N'ALTER AUTHORIZATION ON DATABASE::' + QUOTENAME(" + Literal(db) + ") + N' TO ' + QUOTENAME(SUSER_SNAME(0x01)) + N';';\nEXEC (@sql);", "master", null);
        if (owner.Status != "completed") throw new InvalidOperationException("The fake catalog's owner could not be set: " + owner.Error);
        await Exec(File.ReadAllText(Path.Combine(folder, "schema.sql")));
        await Exec(File.ReadAllText(Path.Combine(folder, "procedures.sql")));
        var shape = await SsisShapeReader.ReadAsync((text, database) => sql(text, database, null), db, "fake", fake: true);
        var differences = SsisManifest.Compare(expected, shape, fake: true);
        check(differences.Count == 0 && shape.Procedures.Count == 4 && shape.SqlAuthRefused.Count == 4,
            "the fake catalog has every catalog view of manifest band " + expected.Band + " as a table with its columns and types, and four stub procedures with the real signatures that refuse SQL Server authentication as the real ones do ("
            + string.Join("; ", differences.Take(8)) + ")");

        // SQL Server authentication: refused with 27123 as the real catalog does; a run connected that way then switches it off for the rest.
        var ownType = await Scalar("SELECT ISNULL((SELECT [type] FROM sys.server_principals WHERE [sid] = SUSER_SID()), '');");
        var missingPackage = string.Format(CultureInfo.InvariantCulture, Create, "N'Missing.dtsx'");
        if (ownType == "S")
        {
            check(await Error(missingPackage) == 27123, "the fake refuses a SQL Server-authenticated caller with 27123 before anything else");
            await Exec("UPDATE [catalog].[varia_fake_settings] SET [refuse_sql_auth] = 0;");
        }
        else if (await scratch.CreateLoginAsync())
        {
            var login = scratch.Login!;
            await Exec("CREATE USER " + Bracket(login) + " FOR LOGIN " + Bracket(login) + ";\nGRANT EXECUTE, SELECT ON SCHEMA::[catalog] TO " + Bracket(login) + ";");
            var codes = await Exec("EXECUTE AS LOGIN = " + Literal(login) + ";\nDECLARE @create int = 0, @stop int = 0;\n"
                + "BEGIN TRY " + missingPackage + " END TRY BEGIN CATCH SET @create = ERROR_NUMBER(); END CATCH\n"
                + "BEGIN TRY EXEC [catalog].[stop_operation] @operation_id = 1; END TRY BEGIN CATCH SET @stop = ERROR_NUMBER(); END CATCH\n"
                + "REVERT;\nSELECT @create, @stop;");
            check(codes.Sets[0][0] is ["27123", "27123"], "the fake refuses a SQL Server login (impersonated) with 27123 in create_execution and stop_operation (" + string.Join(", ", codes.Sets[0][0]) + ")");
        }
        else Console.WriteLine("The fake catalog's SQL Server authentication refusal is not checked: this server accepts Windows logins only.");

        // States and errors: the real numbers for a missing package, a second start, a late parameter, and every stop that cannot happen.
        await Exec("EXEC [catalog].[varia_fake_seed] N'VariaFake', N'Project', N'Package.dtsx'; EXEC [catalog].[varia_fake_seed] N'VariaFake', N'Project', N'Child.dtsx', @entry_point = 0;");
        check(await Error(missingPackage) == 27146 && await Error(string.Format(CultureInfo.InvariantCulture, Create, "N'Child.dtsx'")) == 27146,
            "the fake's create_execution refuses a package that does not exist or is not an entry point with 27146");
        var created = await Execution(start: false);
        var rows = (await Exec("SELECT o.operation_type, o.status, o.object_type, e.execution_id, e.status, e.folder_name, e.project_name, e.package_name, e.use32bitruntime\n"
            + "FROM [catalog].[operations] AS o JOIN [catalog].[executions] AS e ON e.execution_id = o.operation_id WHERE o.operation_id = " + created + ";")).Sets[0];
        check(rows is [["200", "1", "20", var executionId, "1", "VariaFake", "Project", "Package.dtsx", "0"]] && executionId == created.ToString(CultureInfo.InvariantCulture),
            "the fake's create_execution writes an operation of type 200 and its execution with the same id, both Created (1)");
        check(await Error("EXEC [catalog].[set_execution_parameter_value] " + created + ", 50, N'LOGGING_LEVEL', 1;") == 0
            && await Scalar("SELECT parameter_data_type FROM [catalog].[execution_parameter_values] WHERE execution_id = " + created + " AND parameter_name = N'LOGGING_LEVEL';") == "int"
            && await Error("EXEC [catalog].[set_execution_parameter_value] " + created + ", 40, N'LOGGING_LEVEL', 1;") == 27101
            && await Error("EXEC [catalog].[set_execution_parameter_value] 999999999, 50, N'LOGGING_LEVEL', 1;") == 27103
            && await Error("EXEC [catalog].[start_execution] NULL;") == 27138,
            "the fake sets a system parameter with its sql_variant type, and refuses an unknown object type (27101), execution (27103) and a null id (27138)");
        check(await Error("EXEC [catalog].[stop_operation] " + created + ";") == 27124, "the fake refuses to stop an execution that has not started with 27124");
        check(await Error("EXEC [catalog].[start_execution] " + created + ";") == 0
            && await Scalar("SELECT CONCAT(o.status, ' ', e.status, ' ', CASE WHEN o.start_time IS NULL THEN 0 ELSE 1 END) FROM [catalog].[operations] AS o JOIN [catalog].[executions] AS e ON e.execution_id = o.operation_id WHERE o.operation_id = " + created + ";") == "2 2 1"
            && await Error("EXEC [catalog].[start_execution] " + created + ";") == 27121
            && await Error("EXEC [catalog].[set_execution_parameter_value] " + created + ", 50, N'LOGGING_LEVEL', 3;") == 27224,
            "the fake's start_execution makes it Running (2) once, then refuses a second start (27121) and a parameter change (27224)");
        var stops = await Scalar("SELECT COUNT(*) FROM [catalog].[operations] WHERE operation_type = 202;");
        check(await Error("EXEC [catalog].[stop_operation] " + created + ";") == 0
            && await Scalar("SELECT CONCAT(o.status, ' ', e.status, ' ', CASE WHEN o.stopped_by_name = SUSER_SNAME() THEN 1 ELSE 0 END) FROM [catalog].[operations] AS o JOIN [catalog].[executions] AS e ON e.execution_id = o.operation_id WHERE o.operation_id = " + created + ";") == "8 8 1"
            && await Scalar("SELECT COUNT(*) FROM [catalog].[operations] WHERE operation_type = 202;") == (Long(stops) + 1).ToString(CultureInfo.InvariantCulture)
            && await Error("EXEC [catalog].[stop_operation] " + created + ";") == 27126,
            "the fake's stop_operation records a stop operation (202) and makes the execution Stopping (8), and a second stop is 27126");
        check(await Error("EXEC [catalog].[varia_fake_finish] " + created + ", 3;") == 0
            && await Scalar("SELECT CONCAT(status, ' ', CASE WHEN end_time IS NULL THEN 0 ELSE 1 END) FROM [catalog].[executions] WHERE execution_id = " + created + ";") == "3 1"
            && await Error("EXEC [catalog].[stop_operation] " + created + ";") == 27124,
            "an execution the fake ended as Canceled (3) cannot be stopped again (27124)");

        // The commit-order hazard: session A takes the lower id and holds its commit; session B takes the next id and commits.
        async Task<(long Low, Task<SqlRun> Held, string Lock, string Holder)> Hold(long operation)
        {
            var holder = Guid.NewGuid().ToString();
            var name = "varia_fake_hold_" + operation.ToString(CultureInfo.InvariantCulture);
            await Exec("DECLARE @granted int; EXEC @granted = sys.sp_getapplock @Resource = " + Literal(name) + ", @LockMode = N'Exclusive', @LockOwner = N'Session'; IF @granted < 0 THROW 50000, 'no hold', 1;", holder);
            var held = sql("EXEC [catalog].[varia_fake_run] @operation_id = " + operation + ", @messages = 2, @threads = 2, @thread = 0, @hold_first_lock = " + Literal(name) + ";", db, null);
            var watch = Stopwatch.StartNew();
            string? low = null;
            while (low is null && watch.ElapsedMilliseconds < 60_000 && !held.IsCompleted)
            {
                low = await Scalar("SELECT MIN(operation_message_id) FROM [catalog].[operation_messages] WITH (NOLOCK) WHERE operation_id = " + operation + ";");
                if (low is null) await Task.Delay(50);
            }
            if (low is null) throw new InvalidOperationException("The held message never appeared: " + (held.IsCompleted ? (await held).Error : "timed out"));
            await Exec("EXEC [catalog].[varia_fake_run] @operation_id = " + operation + ", @messages = 2, @threads = 2, @thread = 1;");
            return (Long(low), held, name, holder);
        }
        async Task Release((long Low, Task<SqlRun> Held, string Lock, string Holder) hold)
        {
            await Exec("EXEC sys.sp_releaseapplock @Resource = " + Literal(hold.Lock) + ", @LockOwner = N'Session';", hold.Holder);
            var finished = await hold.Held;
            if (finished.Status != "completed") throw new InvalidOperationException("The held session failed: " + finished.Error);
            await close(hold.Holder);
        }
        const string Tail = "SELECT COUNT(*), MAX(operation_message_id) FROM [catalog].[operation_messages] WHERE operation_id = {0} AND operation_message_id > {1};";
        var locking = await Execution(start: true);
        var first = await Hold(locking);
        var blocked = await Error("SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCK_TIMEOUT 1000; " + string.Format(CultureInfo.InvariantCulture, Tail, locking, 0));
        var dirty = (await Exec("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; " + string.Format(CultureInfo.InvariantCulture, Tail, locking, 0))).Sets[0][0];
        await Release(first);
        var inversions = await Scalar("SELECT COUNT(*) FROM [catalog].[varia_fake_commits] AS c JOIN [catalog].[varia_fake_commits] AS d ON d.commit_sequence > c.commit_sequence AND d.operation_message_id < c.operation_message_id\n"
            + "JOIN [catalog].[operation_messages] AS m ON m.operation_message_id = c.operation_message_id WHERE m.operation_id = " + locking + ";");
        check(blocked == 1222 && dirty is ["2", _] && inversions == "1",
            "in the fake, a later message id commits before an earlier one; a READ COMMITTED tail with LOCK_TIMEOUT 1000 waits on the held row and ends with 1222, and READ UNCOMMITTED reads it before it commits (" + blocked + ", " + dirty[0] + ", " + inversions + ")");

        // Under RCSI the same tail does not wait: a naive cursor (the highest id read) moves past the held id and loses it.
        await sql("ALTER DATABASE " + Bracket(db) + " SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;", "master", null);
        check(await sql("SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name = " + Literal(db) + ";", "master", null) is { Scalar: "1" }, "the fake catalog's database switches to RCSI, so tails can be checked in both isolation modes");
        var snapshot = await Execution(start: true);
        var second = await Hold(snapshot);
        var seen = (await Exec(string.Format(CultureInfo.InvariantCulture, Tail, snapshot, 0))).Sets[0][0];
        await Release(second);
        var after = (await Exec(string.Format(CultureInfo.InvariantCulture, Tail, snapshot, seen[1] ?? "0"))).Sets[0][0];
        var total = await Scalar("SELECT COUNT(*) FROM [catalog].[operation_messages] WHERE operation_id = " + snapshot + ";");
        check(seen is ["1", _] && Long(seen[1]) == second.Low + 1 && after is ["0", null] && total == "2",
            "under RCSI the fake's tail reads past a held message without waiting, so a naive highest-id cursor never reads that message once it commits: the settle window D-ssis 5.3 requires");

        // Four sessions writing one execution's log at once, with commits held back: nothing lost or duplicated, and every
        // operation message has its event message under the same id.
        var volume = await Execution(start: true);
        await Task.WhenAll(Enumerable.Range(0, 4).Select(thread => Exec("EXEC [catalog].[varia_fake_run] @operation_id = " + volume + ", @messages = 2000, @threads = 4, @thread = " + thread + ", @hold_every = 25, @hold_ms = 20;")));
        var counts = (await Exec("SELECT COUNT(*), COUNT(DISTINCT m.operation_message_id), SUM(CASE WHEN e.event_message_id = m.operation_message_id THEN 1 ELSE 0 END),\n"
            + "(SELECT COUNT(*) FROM [catalog].[event_messages] WHERE operation_id = " + volume + "),\n"
            + "(SELECT COUNT(*) FROM [catalog].[varia_fake_commits] AS c JOIN [catalog].[varia_fake_commits] AS d ON d.commit_sequence = c.commit_sequence + 1 AND d.operation_message_id < c.operation_message_id\n"
            + "    JOIN [catalog].[operation_messages] AS x ON x.operation_message_id = c.operation_message_id WHERE x.operation_id = " + volume + ")\n"
            + "FROM [catalog].[operation_messages] AS m LEFT JOIN [catalog].[event_messages] AS e ON e.event_message_id = m.operation_message_id WHERE m.operation_id = " + volume + ";")).Sets[0][0];
        check(counts is ["2000", "2000", "2000", "2000", _],
            "four sessions write 2,000 messages of one execution into the fake with none lost or duplicated, each with its event message under the same id (" + counts[4] + " adjacent commits out of id order)");
    }
}
