using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Smo;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live Database Properties checks. Read-only: the describe of master, tempdb and msdb, a missing database, a script
/// that changes nothing, and SQL Server building exactly Script's statement for every batch the catalogue can plan with the
/// database and login named to break out of brackets, strings, comments and lines. With VARIA_TEST_SQL_SCRATCH=1, in a marked
/// VariaScratch_…_dbp database: every settable option and scoped configuration changed and changed back, the owner, SMO
/// parity of the script for SSMS's sequence, Open Connections (IN_USE with NO_WAIT, then ROLLBACK IMMEDIATE), and Stop.</summary>
internal static class DatabasePropertiesLiveChecks
{
    private static readonly string NL = Environment.NewLine;

    private sealed class Client(SqlService service, string connectionId, JsonSerializerOptions json)
    {
        public async Task<T> Call<T>(string method, object args, RequestContext? context = null) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json, context);
        public Task<ActionDescribeResult> Describe(string database) =>
            Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(connectionId, Guid.NewGuid().ToString(), "databaseProperties", new ObjectRefDto("database", Name: database)));
        public ActionArgs Args(string database, DatabaseChangesDto changes, bool close = false) =>
            new("properties", connectionId, Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: database), CloseConnections: close, Changes: changes);
        public Task<ActionScriptResult> Script(string database, DatabaseChangesDto changes) => Call<ActionScriptResult>("actions.script", Args(database, changes));
        public Task<ActionExecuteResult> Execute(string database, DatabaseChangesDto changes, bool close = false, RequestContext? context = null) =>
            Call<ActionExecuteResult>("actions.execute", Args(database, changes, close), context);
    }

    private static bool Done(ActionExecuteResult result) => result.Error is null && result.Steps.Count > 0 && result.Steps.All(step => step.Status == "done");

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var client = new Client(service, info.Id, json);
        var catalog = ActionsCatalog.Current;
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
        var major = int.Parse((await Sql("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion'));")).Scalar!, System.Globalization.CultureInfo.InvariantCulture);
        var level = Math.Min(major * 10, 170);

        // The describe of SQL Server's own databases: files, PRIMARY as the default filegroup, the header's options, the
        // levels up to the server's own, and the collations; none is read-only for a sysadmin.
        var described = new List<string>();
        foreach (var name in new[] { "master", "tempdb", "msdb" })
        {
            var result = await client.Describe(name);
            if (result is { Error: null, DatabaseProperties: { } model } && model.Files.Count >= 2 && model.Files.Any(file => file.Type == "log" && file.Filegroup is null)
                && model.Filegroups.Any(group => group is { Name: "PRIMARY", IsDefault: true, Type: "rows" }) && model.Options.ContainsKey("recoveryModel")
                && model.Options["compatibilityLevel"] == level.ToString(System.Globalization.CultureInfo.InvariantCulture) && model.CompatibilityLevels.Contains(level)
                && model.CompatibilityLevels.Max() == level && model.Collations.Count > 100 && model.Logins.Count > 0 && model.General.Name == name && model.General.Status == "ONLINE"
                && model.General.SizeMb > 0 && model.General.Users >= 4 && model.ReadOnlyReason is null && model.Server.Sysadmin && (major < 13 || model.Scoped.Count == 8))
                described.Add(name);
        }
        check(described.Count == 3, "Database Properties describes master, tempdb and msdb: files, PRIMARY as default, options, levels up to the server's, collations and logins: " + string.Join(", ", described));
        var missing = await client.Describe("VariaMissing_" + Guid.NewGuid().ToString("N"));
        check(missing is { Error.Code: "NOT_FOUND", DatabaseProperties: null }, "describing a database that does not exist is NOT_FOUND");

        // Script runs nothing: master keeps its options.
        var before = (await Sql("SELECT CONVERT(nvarchar(10), is_ansi_nulls_on) + N'/' + CONVERT(nvarchar(10), is_cursor_close_on_commit_on) FROM sys.databases WHERE name = N'master';")).Scalar;
        var flipped = before == "1/0" ? new DatabaseChangesDto(Options: new() { ["ansiNulls"] = "false", ["closeCursorOnCommit"] = "true" })
            : new DatabaseChangesDto(Options: new() { ["ansiNulls"] = "true", ["closeCursorOnCommit"] = "false" });
        var script = await client.Script("master", flipped);
        var after = (await Sql("SELECT CONVERT(nvarchar(10), is_ansi_nulls_on) + N'/' + CONVERT(nvarchar(10), is_cursor_close_on_commit_on) FROM sys.databases WHERE name = N'master';")).Scalar;
        check(script is { Error: null, Database: "master", Text: { } text } && text.StartsWith("USE [master]" + NL + "GO" + NL + "ALTER DATABASE [master] SET ANSI_NULLS ", StringComparison.Ordinal)
            && after == before, "Script of a change on master returns SSMS's text and changes nothing (" + before + " then " + after + ")");
        var refused = await client.Script("tempdb", new DatabaseChangesDto(Options: new() { ["recoveryModel"] = "FULL" }));
        check(refused is { Error.Code: "NOT_SUPPORTED", Text: null }, "Script refuses what SQL Server refuses on its own databases (tempdb's recovery model)");
        // A document stays open while Object Explorer renames, drops or restores databases: Script and Apply name the database
        // read (database_id, create_date as the describe wrote it), and the preflight refuses another that has the name now.
        var masterModel = (await client.Describe("master")).DatabaseProperties;
        var msdbModel = (await client.Describe("msdb")).DatabaseProperties;
        var masterIdentity = masterModel?.General.Id is { } masterId ? new DatabaseIdentityDto(masterId, masterModel.General.Created) : null;
        var same = await client.Call<ActionScriptResult>("actions.script", client.Args("master", flipped) with { Identity = masterIdentity });
        var other = await client.Call<ActionScriptResult>("actions.script", client.Args("msdb", flipped) with { Identity = masterIdentity });
        check(masterIdentity is { Id: > 0 } && msdbModel?.General.Id is { } msdbId && msdbId != masterIdentity.Id && same is { Error: null, Text: not null }
            && other is { Error.Code: "NOT_FOUND", Text: null } && other.Error.Message.Contains("not the one these properties were read from", StringComparison.Ordinal),
            "Script names the database it read: master's identity scripts master, and msdb under master's identity is refused NOT_FOUND");

        // SQL Server builds exactly Script's statement for every batch the catalogue can plan, with the database and the
        // login named by every hostile fragment at the sysname limit, and nothing runs.
        var databases = ScratchDatabase.Lasting(await Sql(ScratchDatabase.DatabaseNamesSql));
        var mismatches = new List<string>();
        var total = 0;
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append(" ").Append("‮"))
        {
            var name = ActionChecks.Long(fragment);
            var corpus = DatabaseAlter.Corpus(catalog, name).Select(statement => statement.Template == AlterTemplate.Owner ? statement with { Name = name } : statement).ToList();
            var selected = await service.Actions.DryRunAsync(info.Id, corpus, CancellationToken.None);
            for (var index = 0; index < corpus.Count; index++)
                if (!selected[index].SequenceEqual([DatabaseAlter.Statement(catalog, corpus[index])])) mismatches.Add(corpus[index].Template + " " + corpus[index].Key + " " + fragment[..1]);
            total += corpus.Count;
        }
        check(mismatches.Count == 0 && total > 1000 && ScratchDatabase.Lasting(await Sql(ScratchDatabase.DatabaseNamesSql)) == databases,
            "SQL Server builds exactly Script's statement for all " + total + " Database Properties batches with hostile database and login names, and the dry run changes nothing: " + string.Join(", ", mismatches.Take(5)));

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Database Properties scratch-database checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var db = await scratch.CreatePropertiesAsync();
        await ScratchAsync(check, service, client, catalog, json, Sql, info, db);
    }

    private static async Task ScratchAsync(Action<bool, string> check, SqlService service, Client client, ActionsCatalog catalog, JsonSerializerOptions json,
        Func<string, string, string?, Task<SqlRun>> sql, ConnectionInfo info, string db)
    {
        async Task<DatabasePropertiesDto> Model() => (await client.Describe(db)).DatabaseProperties ?? throw new InvalidOperationException("The scratch database could not be described.");
        var model = await Model();

        // Every settable option and scoped configuration: changed, read back, and changed back.
        var skipped = new List<string>();
        var failed = new List<string>();
        var changedCount = 0;
        // Only levels the server offers: SQL Server 2017's highest is 140, so a fixed 150 would be refused there.
        string OtherLevel(string current) => model.CompatibilityLevels.Where(level => level.ToString(CultureInfo.InvariantCulture) != current).Max().ToString(CultureInfo.InvariantCulture);
        string? Other(OptionJson option, string current) => option.Key switch
        {
            "collation" => current == "Latin1_General_BIN2" ? "Latin1_General_CI_AS" : "Latin1_General_BIN2",
            "compatibilityLevel" => OtherLevel(current),
            "targetRecoveryTime" => current == "30" ? "60" : "30",
            "maxDop" => current == "4" ? "0" : "4",
            "maxDopForSecondary" => current == "PRIMARY" ? "2" : "PRIMARY",
            _ => option.Tokens?.FirstOrDefault(token => token != current)
        };
        foreach (var option in catalog.DatabaseOptions.Values.Concat(catalog.ScopedConfigurations.Values).Where(option => option.Settable).OrderBy(option => option.SmoOrder))
        {
            var scoped = catalog.ScopedConfigurations.ContainsKey(option.Key);
            if (option.Key == "filestreamNonTransactedAccess" && model.Server.FilestreamLevel < 2) { skipped.Add(option.Key + " (FILESTREAM is not enabled)"); continue; }
            if (option.Key == "containmentType" && !model.Server.ContainedAuthentication) { skipped.Add(option.Key + " (contained database authentication is off)"); continue; }
            var values = scoped ? model.Scoped : model.Options;
            if (!values.TryGetValue(option.Key, out var original) || Other(option, original) is not { } next) { failed.Add(option.Key + " has no value"); continue; }
            DatabaseChangesDto Change(string token) => scoped ? new(Scoped: new() { [option.Key] = token }) : new(Options: new() { [option.Key] = token });
            var close = option.Exclusive == true;
            var forward = await client.Execute(db, Change(next), close);
            var read = await Model();
            var back = await client.Execute(db, Change(original), close);
            model = await Model();
            var readValue = (scoped ? read.Scoped : read.Options).GetValueOrDefault(option.Key);
            var restored = (scoped ? model.Scoped : model.Options).GetValueOrDefault(option.Key);
            if (Done(forward) && readValue == next && Done(back) && restored == original) changedCount++;
            else failed.Add(option.Key + ": " + (forward.Error?.Message ?? readValue) + " / " + (back.Error?.Message ?? restored));
        }
        check(failed.Count == 0 && changedCount + skipped.Count == catalog.DatabaseOptions.Values.Concat(catalog.ScopedConfigurations.Values).Count(option => option.Settable) && changedCount >= 36, "every settable option and scoped configuration changes through Execute, reads back through the describe, and changes back (" + changedCount
            + " changed; skipped " + string.Join(", ", skipped) + "): " + string.Join("; ", failed));
        if (skipped.Count > 0) Console.WriteLine("Database Properties: skipped " + string.Join(", ", skipped) + ".");

        // The owner: to sa and back to the login that created the database.
        var creator = model.General.Owner!;
        var toSa = await client.Execute(db, new DatabaseChangesDto(Owner: "sa"));
        var owned = (await Model()).General.Owner;
        var backToCreator = await client.Execute(db, new DatabaseChangesDto(Owner: creator));
        var noLogin = await client.Execute(db, new DatabaseChangesDto(Owner: "VariaNoLogin_" + Guid.NewGuid().ToString("N")));
        check(Done(toSa) && owned == "sa" && Done(backToCreator) && (await Model()).General.Owner == creator && noLogin is { Error.Code: "NOT_FOUND", Steps.Count: 0 },
            "the owner changes with ALTER AUTHORIZATION and back, and a login that does not exist is NOT_FOUND before any DDL (" + toSa.Error?.Message + ")");

        // SMO parity: SSMS's sequence driven through SMO 181 in capture mode writes exactly Script's text.
        await using (var connection = ((IActionHost)service).Connection(info.Id))
        {
            await ((IActionHost)service).OpenAsync(connection, CancellationToken.None);
            var level = OtherLevel(model.Options["compatibilityLevel"]);
            var smoLevel = Enum.Parse<CompatibilityLevel>("Version" + level);
            var sets = new (string Name, DatabaseChangesDto Changes, Action<Database> Apply, bool? Snapshot, string? Owner)[]
            {
                ("SET options", new(Options: new() { ["recoveryModel"] = "FULL", ["autoClose"] = "true", ["ansiNulls"] = "true", ["compatibilityLevel"] = level, ["pageVerify"] = "TORN_PAGE_DETECTION",
                    ["defaultCursor"] = "LOCAL", ["brokerEnabled"] = "true", ["parameterization"] = "FORCED",
                    ["autoCreateStatistics"] = "false", ["readOnly"] = "true", ["restrictAccess"] = "RESTRICTED_USER", ["collation"] = "Latin1_General_BIN2", ["dateCorrelationOptimization"] = "true" }),
                    database =>
                    {
                        database.DatabaseOptions.RecoveryModel = RecoveryModel.Full; database.DatabaseOptions.AutoClose = true; database.DatabaseOptions.AnsiNullsEnabled = true;
                        database.CompatibilityLevel = smoLevel; database.DatabaseOptions.PageVerify = PageVerify.TornPageDetection;
                        database.DatabaseOptions.LocalCursorsDefault = true; database.BrokerEnabled = true;
                        database.DatabaseOptions.IsParameterizationForced = true; database.DatabaseOptions.AutoCreateStatistics = false; database.DatabaseOptions.ReadOnly = true;
                        database.DatabaseOptions.UserAccess = DatabaseUserAccess.Restricted; database.Collation = "Latin1_General_BIN2"; database.DatabaseOptions.DateCorrelationOptimization = true;
                    }, null, null),
                // Target Recovery Time and Delayed Durability cannot follow Read-Only's True in one OK, so they are here.
                ("statistics and scoped configurations", new(Options: new() { ["autoCreateIncrementalStatistics"] = "true", ["ansiPadding"] = "true", ["arithmeticAbort"] = "true",
                    ["targetRecoveryTime"] = "30", ["delayedDurability"] = "FORCED" },
                    Scoped: new() { ["maxDop"] = "4", ["legacyCardinalityEstimation"] = "ON", ["maxDopForSecondary"] = "2", ["parameterSniffingForSecondary"] = "OFF" }),
                    database =>
                    {
                        database.DatabaseOptions.AutoCreateStatisticsIncremental = true; database.DatabaseOptions.AnsiPaddingEnabled = true; database.DatabaseOptions.ArithmeticAbortEnabled = true;
                        database.TargetRecoveryTime = 30; database.DelayedDurability = DelayedDurability.Forced;
                        database.MaxDop = 4; database.LegacyCardinalityEstimation = DatabaseScopedConfigurationOnOff.On; database.MaxDopForSecondary = 2;
                        database.ParameterSniffingForSecondary = DatabaseScopedConfigurationOnOff.Off;
                    }, null, null),
                ("snapshot isolation and owner", new(Owner: "sa", Options: new() { ["allowSnapshotIsolation"] = "true", ["readCommittedSnapshot"] = "true" }),
                    database => database.IsReadCommittedSnapshotOn = true, true, "sa")
            };
            var differences = new List<string>();
            foreach (var (name, changes, apply, snapshot, owner) in sets)
            {
                var server = new Server(new ServerConnection(connection) { AutoDisconnectMode = AutoDisconnectMode.NoAutoDisconnect });
                var database = server.Databases[db];
                database.Refresh();
                _ = database.DatabaseOptions.RecoveryModel;
                _ = database.DatabaseScopedConfigurations.Count;
                server.ConnectionContext.SqlExecutionModes = SqlExecutionModes.CaptureSql;
                server.ConnectionContext.CapturedSql.Clear();
                apply(database);
                database.Alter(TerminationClause.FailOnOpenTransactions);
                if (snapshot is { } enabled) database.SetSnapshotIsolation(enabled);
                if (owner is not null) database.SetOwner(owner, false);
                // SMO captures an empty batch at the end of Database.Alter; it holds no statement, so it is not compared.
                var captured = string.Concat(server.ConnectionContext.CapturedSql.Text.Cast<string>().Where(batch => !string.IsNullOrWhiteSpace(batch)).Select(batch => batch.ReplaceLineEndings(NL) + NL + "GO" + NL));
                server.ConnectionContext.SqlExecutionModes = SqlExecutionModes.ExecuteSql;
                var ours = await client.Script(db, changes);
                if (ours.Text?.ReplaceLineEndings(NL) != captured) differences.Add(name + ":" + NL + "SMO:" + NL + captured + "Varia:" + NL + (ours.Text ?? ours.Error?.Message));
            }
            check(differences.Count == 0, "Script writes exactly what SMO 181 captures for SSMS's sequence (Alter with FailOnOpenTransactions, SetSnapshotIsolation, SetOwner):" + NL + string.Join(NL, differences));
        }

        // Open Connections, with another session in the database. Broker Enabled, which SSMS does not close connections for,
        // fails WITH NO_WAIT (SQL Server gives up after about 20 s, measured on SQL Server 2025, instead of waiting for the
        // transaction) and advises closing them, since no prompt offers Yes. Read-Only without closing them (the dialog's
        // count was 0) is refused by the preflight's count before any statement runs, as SSMS counts them at OK; with
        // ROLLBACK IMMEDIATE (Yes) it succeeds and the other session's connection is closed.
        var other = Guid.NewGuid().ToString();
        var broker = model.Options["brokerEnabled"];
        try
        {
            var inside = await sql("BEGIN TRANSACTION; SELECT 1;", db, other);
            var watch = Stopwatch.StartNew();
            var brokerChange = await client.Execute(db, new DatabaseChangesDto(Options: new() { ["brokerEnabled"] = broker == "true" ? "false" : "true" }));
            var brokerMs = watch.ElapsedMilliseconds;
            var brokerAfter = (await Model()).Options["brokerEnabled"];
            check(inside.Status == "completed" && brokerChange is { Error.Code: "IN_USE" } && brokerChange.Error.Message.EndsWith(ActionErrors.OtherConnectionsAdvice, StringComparison.Ordinal)
                && brokerChange.Steps.Count == 1 && brokerAfter == broker,
                "with another session in the database, Broker Enabled WITH NO_WAIT is IN_USE in " + brokerMs + " ms, changes nothing, and advises closing the connections rather than a Yes no prompt offers ("
                + brokerChange.Error?.Message + ")");
            var noWait = await client.Execute(db, new DatabaseChangesDto(Options: new() { ["readOnly"] = "true" }));
            var stillWritable = (await Model()).Options["readOnly"];
            var rollback = await client.Execute(db, new DatabaseChangesDto(Options: new() { ["readOnly"] = "true" }), close: true);
            var readOnly = (await Model()).Options["readOnly"];
            // The closed session can stay in sys.dm_exec_sessions for a moment after the ALTER returns (a Linux CI run counted
            // it once), so the count gets a few seconds to reach 0.
            var sessions = "";
            for (var settle = Stopwatch.StartNew(); ; await Task.Delay(250))
            {
                sessions = (await sql("SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE database_id = DB_ID(N'" + db + "');", "master", null)).Scalar ?? "";
                if (sessions == "0" || settle.ElapsedMilliseconds > 10_000) break;
            }
            check(noWait is { Error.Code: "IN_USE", Steps.Count: 0 } && noWait.Error.Message == ActionErrors.OpenConnectionsAdvice
                && stillWritable == "false" && Done(rollback) && readOnly == "true" && sessions == "0",
                "with another session in the database, Read-Only without closing connections is IN_USE before any statement runs and changes nothing; WITH ROLLBACK IMMEDIATE it succeeds and closes that session ("
                + noWait.Error?.Message + "; " + rollback.Error?.Message + "; writable before " + stillWritable + ", read-only after " + readOnly + ", " + sessions + " sessions left)");
        }
        finally
        {
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(other), json), json);
            await client.Execute(db, new DatabaseChangesDto(Options: new() { ["readOnly"] = "false" }), close: true);
            if ((await Model()).Options["brokerEnabled"] != broker) await client.Execute(db, new DatabaseChangesDto(Options: new() { ["brokerEnabled"] = broker }));
        }

        // Read-Only cannot share an OK with a change SQL Server refuses once the database is read-only: nothing runs.
        var partial = await client.Execute(db, new DatabaseChangesDto(Owner: "sa", Options: new() { ["readOnly"] = "true" }, Scoped: new() { ["maxDop"] = "4" }), close: true);
        var untouched = await Model();
        check(partial is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && partial.Error.Message == DatabaseAlter.AfterReadOnlyProblem("Max DOP") && untouched.Options["readOnly"] == "false"
            && untouched.Scoped["maxDop"] == model.Scoped["maxDop"], "Read-Only with a scoped configuration and the owner is refused before anything runs, leaving the database writable (" + partial.Error?.Message + ")");

        // Why FILESTREAM Non-Transacted Access is refusedReadOnly: SET FILESTREAM, which SMO writes after READ_ONLY, fails on a
        // read-only database (3906 on SQL Server 2025, where it works on a writable one even with FILESTREAM off).
        var filestreamOff = "ALTER DATABASE " + ScriptFormatterQuote(db) + " SET FILESTREAM( NON_TRANSACTED_ACCESS = OFF ) WITH NO_WAIT;";
        var writableFilestream = await sql(filestreamOff, "master", null);
        if (writableFilestream.Status == "completed")
        {
            try
            {
                var madeReadOnly = await client.Execute(db, new DatabaseChangesDto(Options: new() { ["readOnly"] = "true" }), close: true);
                var readOnlyFilestream = await sql(filestreamOff, "master", null);
                check(Done(madeReadOnly) && readOnlyFilestream.Status != "completed",
                    "SET FILESTREAM (NON_TRANSACTED_ACCESS) fails on a read-only database, so it cannot follow Read-Only's True in one OK (" + readOnlyFilestream.Error + ")");
            }
            finally { await client.Execute(db, new DatabaseChangesDto(Options: new() { ["readOnly"] = "false" }), close: true); }
        }
        else Console.WriteLine("Database Properties: SET FILESTREAM fails on a writable database here (" + writableFilestream.Error + "); its read-only check is skipped.");

        // The backend's own pooled connection in the database, still in use while execute clears the pools and closed 300 ms
        // later: SQL Server ends its session only then, after the preflight's first count. Without counting again, a session
        // the backend itself closes would answer IN_USE.
        ActionExecuteResult afterOwnPool;
        await using (var pooled = ((Varia.Backend.Explorer.IExplorerHost)service).Connection(info.Id, db))
        {
            await pooled.OpenAsync();
            var running = client.Execute(db, new DatabaseChangesDto(Options: new() { ["readOnly"] = "true" }));
            await Task.Delay(300);
            await pooled.CloseAsync();
            afterOwnPool = await running;
        }
        var ownPoolReadOnly = (await Model()).Options["readOnly"];
        await client.Execute(db, new DatabaseChangesDto(Options: new() { ["readOnly"] = "false" }), close: true);
        check(Done(afterOwnPool) && ownPoolReadOnly == "true",
            "a pooled connection of the backend's own that closes after execute cleared the pools is not counted as another connection (" + afterOwnPool.Error?.Message + ")");

        // Stop: ALTER AUTHORIZATION waits behind another session's open transaction that changed the owner, until Stop
        // cancels it in SQL Server.
        var holder = Guid.NewGuid().ToString();
        try
        {
            var held = await sql("BEGIN TRANSACTION; ALTER AUTHORIZATION ON DATABASE::" + ScriptFormatterQuote(db) + " TO [sa];", "master", holder);
            using var context = new RequestContext(3, "actions.execute", RequestLane.Actions, 0);
            var waiting = client.Execute(db, new DatabaseChangesDto(Owner: "sa"), context: context);
            var stillWaiting = !await Task.WhenAny(waiting, Task.Delay(2000)).ContinueWith(done => done.Result == waiting);
            context.Cancel(CancelReason.User);
            ActionExecuteResult? stopped = null;
            try { stopped = await waiting; } catch (OperationCanceledException) { }
            if (held.Status == "completed" && stillWaiting)
                // The preflight's read of sys.databases can be what waits; then nothing had started and no step is listed.
                check(stopped is { Error.Code: "CANCELLED" } && (stopped.Steps.Count == 0 || stopped.Steps.Select(step => step.Status).SequenceEqual(["cancelled"])),
                    "an ALTER AUTHORIZATION waiting behind another session's transaction answers CANCELLED with its step cancelled when stopped (" + stopped?.Error?.Message + ")");
            else Console.WriteLine("Database Properties Stop check: no plan statement could be made to wait (" + held.Status + ", " + held.Error + "); PR17's Stop check covers the framework.");
        }
        finally
        {
            await sql("IF @@TRANCOUNT > 0 ROLLBACK;", "master", holder);
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(holder), json), json);
        }
    }

    private static string ScriptFormatterQuote(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
}
