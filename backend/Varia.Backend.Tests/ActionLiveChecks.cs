using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live object action checks. Without scratch databases: SQL Server's own objects are refused and the server is
/// unchanged, the server builds exactly the statement Script Action shows for every hostile name, and a script runs
/// nothing. With VARIA_TEST_SQL_SCRATCH=1, in a marked VariaScratch_…_act database: rename and delete of each kind with
/// names that break out of brackets, strings, comments and lines, collisions, dependents, a DROP waiting on another
/// session's lock until Stop, the database's rename and back (also from a connection opened in it), and its delete (in
/// use, which keeps its backup history; Stop after the DROP; closing connections and deleting the history), with the pool
/// regression and Azure SQL Database's per-database column read.</summary>
internal static class ActionLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    private sealed class Client(SqlService service, string connectionId, JsonSerializerOptions json)
    {
        public string ConnectionId { get; } = connectionId;
        public async Task<T> Call<T>(string method, object args, RequestContext? context = null) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json, context);
        public Task<ActionExecuteResult> Rename(ObjectRefDto target, string name, RequestContext? context = null) =>
            Call<ActionExecuteResult>("actions.execute", new ActionArgs("rename", ConnectionId, Guid.NewGuid().ToString(), target, name), context);
        public Task<ActionExecuteResult> Delete(ObjectRefDto target, bool close = false, bool history = false, RequestContext? context = null) =>
            Call<ActionExecuteResult>("actions.execute", new ActionArgs("delete", ConnectionId, Guid.NewGuid().ToString(), target, null, close, history), context);
        public Task<ActionScriptResult> Script(ActionArgs args) => Call<ActionScriptResult>("actions.script", args);
        public Task<ActionDescribeResult> Describe(ObjectRefDto target) =>
            Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(ConnectionId, Guid.NewGuid().ToString(), "deleteObject", target));
        public async Task<string> Refused(Func<Task<object>> call)
        {
            try { return await call() is ActionExecuteResult { Error: { } error } ? error.Code : "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
    }

    private static bool Done(ActionExecuteResult result) => result.Error is null && result.Steps.Count > 0 && result.Steps.All(step => step.Status == "done");

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, ConnectOptions options, JsonSerializerOptions json)
    {
        var client = new Client(service, info.Id, json);
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

        // SQL Server's own objects: refused before any DDL, and nothing changes.
        var databases = (await Sql("SELECT COUNT(*) FROM sys.databases;")).Scalar;
        var sysjobs = new ObjectRefDto("table", "msdb", "dbo", "sysjobs");
        var refusals = new[]
        {
            await client.Refused(async () => await client.Rename(new ObjectRefDto("database", Name: "master"), "master2")),
            await client.Refused(async () => await client.Delete(new ObjectRefDto("database", Name: "master"))),
            await client.Refused(async () => await client.Rename(sysjobs, "sysjobs2")),
            await client.Refused(async () => await client.Delete(sysjobs))
        };
        check(refusals.SequenceEqual(["INVALID_PARAMS", "INVALID_PARAMS", "NOT_SUPPORTED", "NOT_SUPPORTED"])
            && (await Sql("SELECT COUNT(*) FROM sys.databases;")).Scalar == databases && (await Sql("SELECT COUNT(*) FROM msdb.sys.tables WHERE name = N'sysjobs';")).Scalar == "1",
            "rename and delete of master and msdb.dbo.sysjobs are refused and the server is unchanged: " + string.Join(", ", refusals));
        var described = await client.Describe(sysjobs);
        check(described is { Error: null, DeleteTarget: { Name: "dbo.sysjobs", Type: "Table", Owner: "dbo", DependentsTruncated: false } } && described.ElapsedMs >= 0,
            "Delete Object describes msdb.dbo.sysjobs: its name, type and owner");
        var script = await client.Script(new ActionArgs("delete", info.Id, Guid.NewGuid().ToString(), sysjobs, null, false, false));
        var nl = Environment.NewLine;
        check(script is { Error: null, Database: "msdb" } && script.Text == "USE [msdb]" + nl + "GO" + nl + "DROP TABLE [dbo].[sysjobs]" + nl + "GO" + nl
            && (await Sql("SELECT COUNT(*) FROM msdb.sys.tables WHERE name = N'sysjobs';")).Scalar == "1", "Script Action returns SSMS's DROP text and runs nothing");

        // The server builds the statement Script Action shows, for every hostile name at the sysname limit, and no DDL runs.
        var mismatches = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append(" ").Append("‮"))
        {
            var name = ActionChecks.Long(fragment);
            foreach (var template in Enum.GetValues<ActionTemplate>())
            {
                var plan = new PlannedStatement(template, "master", Enumerable.Repeat(name, ActionSql.ParameterCount(template)).ToList());
                var selected = await service.Actions.DryRunAsync(info.Id, plan, CancellationToken.None);
                var expected = template switch
                {
                    ActionTemplate.RenameObject => [Bracket(name) + "." + Bracket(name), name],
                    ActionTemplate.DeleteBackupHistory => [name],
                    _ => new List<string?> { ActionSql.Statement(plan) }
                };
                if (!selected.SequenceEqual(expected)) mismatches.Add(template + " " + fragment[..1]);
            }
        }
        check(mismatches.Count == 0 && (await Sql("SELECT COUNT(*) FROM sys.databases;")).Scalar == databases,
            "SQL Server's QUOTENAME builds exactly the statement Script Action shows for every template and hostile name, and the dry run changes nothing: " + string.Join(", ", mismatches));

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Object action scratch-database checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        await ScratchAsync(check, service, client, json, Sql, options, scratch);
    }

    private static async Task ScratchAsync(Action<bool, string> check, SqlService service, Client client, JsonSerializerOptions json, Func<string, string, string?, Task<SqlRun>> sql,
        ConnectOptions options, ScratchDatabase scratch)
    {
        var db = await scratch.CreateActionsAsync();
        async Task<SqlRun> Exec(string text, string database = "master")
        {
            var result = await sql(text, database, null);
            if (result.Status != "completed") throw new InvalidOperationException("Object action fixture failed: " + result.Error);
            return result;
        }
        async Task<int> Count(string schema, string name, string database) =>
            int.Parse((await Exec("SELECT COUNT(*) FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE s.name = " + Literal(schema) + " AND o.name = " + Literal(name) + ";", database)).Scalar!,
                System.Globalization.CultureInfo.InvariantCulture);
        ObjectRefDto Ref(string kind, string name) => new(kind, db, "dbo", name);
        await Exec("CREATE TABLE dbo.Canary (id int); INSERT dbo.Canary VALUES (1);", db);
        var fragments = InjectionMatrix.Fragments;
        string Old(string letter, int index) => letter + fragments[index % fragments.Length];
        string New(string letter, int index) => ActionChecks.Long("n" + letter + fragments[(index + 1) % fragments.Length]);
        var kinds = new (string Letter, string Kind, Func<string, string> Create)[]
        {
            ("t", "table", name => "CREATE TABLE dbo." + Bracket(name) + " (id int);"),
            ("v", "view", name => "CREATE VIEW dbo." + Bracket(name) + " AS SELECT 1 AS a;"),
            ("p", "procedure", name => "CREATE PROCEDURE dbo." + Bracket(name) + " AS SELECT 1;"),
            ("f", "function", name => "CREATE FUNCTION dbo." + Bracket(name) + " () RETURNS int AS BEGIN RETURN 1; END;")
        };
        // Rename: each kind under a hostile name gets another one, and sp_rename's caution comes back as a message.
        var renamed = new List<string>();
        for (var index = 0; index < kinds.Length; index++)
        {
            var (letter, kind, create) = kinds[index];
            await Exec(create(Old(letter, index)), db);
            var result = await client.Rename(Ref(kind, Old(letter, index)), New(letter, index));
            if (Done(result) && result.Messages.Any(message => message.StartsWith("Caution: Changing any part of an object name", StringComparison.Ordinal))
                && await Count("dbo", New(letter, index), db) == 1 && await Count("dbo", Old(letter, index), db) == 0) renamed.Add(kind);
        }
        var listed = await client.Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(client.ConnectionId, Guid.NewGuid().ToString(),
            new NodeRefDto("folder", Owner: new ObjectRefDto("database", Name: db), Folder: "tables")));
        check(renamed.SequenceEqual(kinds.Select(item => item.Kind)) && listed.Nodes.Any(node => node.Ref.Object?.Name == New("t", 0)),
            "Rename renames a table, a view, a procedure and a function from one hostile name to another, with sp_rename's caution, and Tables lists the new name: " + string.Join(", ", renamed));
        await Exec("CREATE TABLE dbo.Taken (id int); CREATE TABLE dbo.Other (id int);", db);
        var collision = await client.Rename(Ref("table", "Other"), "Taken");
        var caseOnly = await client.Rename(Ref("table", "Other"), "OTHER");
        check(collision is { Error.Code: "NAME_IN_USE", Steps.Count: 0 } && await Count("dbo", "Other", db) == 0 && Done(caseOnly) && await Count("dbo", "OTHER", db) == 1,
            "a name already taken in the schema is NAME_IN_USE before any DDL, and a case-only rename is not a collision");

        // Delete: each renamed object goes, and the canary every fragment aims at stays.
        var deleted = new List<string>();
        for (var index = 0; index < kinds.Length; index++)
        {
            var (letter, kind, _) = kinds[index];
            var target = Ref(kind, New(letter, index));
            var preview = await client.Script(new ActionArgs("delete", client.ConnectionId, Guid.NewGuid().ToString(), target, null, false, false));
            var result = await client.Delete(target);
            if (preview.Text is { } text && SqlScript.Parse(text).Count == 2 && Done(result) && await Count("dbo", New(letter, index), db) == 0) deleted.Add(kind);
        }
        var canary = await Exec("SELECT (SELECT COUNT(*) FROM dbo.Canary), CASE WHEN OBJECT_ID(N'dbo.Pwned') IS NULL THEN 0 ELSE 1 END;", db);
        check(deleted.SequenceEqual(kinds.Select(item => item.Kind)) && canary.Sets[0][0][0] == "1" && canary.Sets[0][0][1] == "0",
            "Delete drops each kind under a hostile name, its script splits into USE and DROP, and nothing else changes: " + string.Join(", ", deleted));

        // Dependents: the describe lists what blocks the DROP, which then fails with SQL Server's message and changes nothing.
        await Exec("CREATE TABLE dbo.Parent (id int PRIMARY KEY); CREATE TABLE dbo.Child (id int, parent int CONSTRAINT FK_Child_Parent REFERENCES dbo.Parent (id));", db);
        await Exec("CREATE TABLE dbo.Base (id int);", db);
        await Exec("CREATE VIEW dbo.Bound WITH SCHEMABINDING AS SELECT id FROM dbo.Base;", db);
        var parent = await client.Describe(Ref("table", "Parent"));
        var fk = await client.Delete(Ref("table", "Parent"));
        var baseView = await client.Describe(Ref("table", "Base"));
        var bound = await client.Delete(Ref("table", "Base"));
        check(parent.DeleteTarget?.Warnings.SingleOrDefault() is { Blocking: true, Text: "Referenced by foreign key FK_Child_Parent on dbo.Child; the DROP fails until it is dropped." }
            && fk is { Error.Code: "DEPENDENTS" } && fk.Steps.Single().Status == "failed" && fk.Error.Message.Contains("FOREIGN KEY", StringComparison.Ordinal) && await Count("dbo", "Parent", db) == 1
            && baseView.DeleteTarget?.Warnings.SingleOrDefault()?.Text == "Referenced by schema-bound view dbo.Bound; the DROP fails until it is changed."
            && bound is { Error.Code: "DEPENDENTS" } && await Count("dbo", "Base", db) == 1, "a foreign key (Msg 3726) and a schema-bound view (Msg 3729) block the DROP, as the describe warned");

        // A DROP waits behind another session's lock, as SSMS's does, until Stop cancels it in SQL Server.
        await Exec("CREATE TABLE dbo.Locked (id int);", db);
        var holder = Guid.NewGuid().ToString();
        try
        {
            var held = await sql("BEGIN TRANSACTION; SELECT COUNT(*) FROM dbo.Locked WITH (TABLOCKX, HOLDLOCK);", db, holder);
            using var context = new RequestContext(1, "actions.execute", RequestLane.Actions, 0);
            var waiting = client.Delete(Ref("table", "Locked"), context: context);
            var stillWaiting = !await Task.WhenAny(waiting, Task.Delay(2000)).ContinueWith(done => done.Result == waiting);
            // This process's action session is blocked on a lock with LOCK_TIMEOUT -1, as SSMS's would be.
            var blocked = await Exec("SELECT CONVERT(nvarchar(20), s.lock_timeout) + N' ' + r.wait_type FROM sys.dm_exec_requests AS r JOIN sys.dm_exec_sessions AS s ON s.session_id = r.session_id "
                + "WHERE s.host_process_id = " + Environment.ProcessId + " AND s.program_name LIKE N'% - Object Actions' AND r.blocking_session_id <> 0;");
            var watch = Stopwatch.StartNew();
            context.Cancel(CancelReason.User);
            ActionExecuteResult? stopped = null;
            try { stopped = await waiting; } catch (OperationCanceledException) { }
            var answeredMs = watch.ElapsedMilliseconds;
            // The answer waited for SQL Server to end the statement, so the job and its connection are already gone.
            var jobs = service.Actions.ActiveJobs;
            check(held.Status == "completed" && stillWaiting && blocked.Scalar?.StartsWith("-1 LCK_M_", StringComparison.Ordinal) == true && stopped is { Error.Code: "CANCELLED" }
                && stopped.Steps.Select(step => step.Status).SequenceEqual(["cancelled"]) && answeredMs < 5000 && jobs == 0 && await Count("dbo", "Locked", db) == 1,
                "a DROP waits on another session's lock without a timeout, and Stop answers once SQL Server cancelled it, with its step cancelled and the table kept (" + blocked.Scalar + ", " + answeredMs + " ms, "
                + stopped?.Error?.Message + ")");
        }
        finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(holder), json), json); }
        check(Done(await client.Delete(Ref("table", "Locked"))), "after the lock is released, the same DROP runs");

        // The database: renamed to _actr and back.
        var database = new ObjectRefDto("database", Name: db);
        var away = await client.Rename(database, scratch.ActionsRenamed);
        var gone = (await Exec("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar;
        var back = await client.Rename(new ObjectRefDto("database", Name: scratch.ActionsRenamed), db);
        check(Done(away) && gone == "0" && Done(back) && (await Exec("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar == "1",
            "a database is renamed with ALTER DATABASE … MODIFY NAME, and back");

        // A connection opened in the database (the Connect dialog's Database) still lists databases and Object Explorer's
        // Databases folder after it renames that database, and after renaming it back.
        async Task<string> Listing(string connectionId, string expected)
        {
            try
            {
                var names = await client.Call<List<DatabaseInfo>>("databases.list", new ConnectionArgs(connectionId));
                var folder = await client.Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(connectionId, Guid.NewGuid().ToString(),
                    new NodeRefDto("folder", Owner: new ObjectRefDto("server"), Folder: "databases")));
                return names.Any(item => item.Name == expected) && folder.Error is null ? "listed" : "missing " + folder.Error?.Message;
            }
            catch (RequestException error) { return error.Code + " " + error.Message; }
            catch (Microsoft.Data.SqlClient.SqlException error) { return "Msg " + error.Number; }
        }
        var opened = await client.Call<ConnectionInfo>("connections.connect", options with { Database = db });
        try
        {
            var inside = new Client(service, opened.Id, json);
            var renamedFromInside = await inside.Rename(database, scratch.ActionsRenamed);
            var afterRename = await Listing(opened.Id, scratch.ActionsRenamed);
            var renamedBack = await inside.Rename(new ObjectRefDto("database", Name: scratch.ActionsRenamed), db);
            var afterBack = await Listing(opened.Id, db);
            check(opened.Database == db && Done(renamedFromInside) && afterRename == "listed" && Done(renamedBack) && afterBack == "listed",
                "a connection opened in a database keeps working after it renames that database and back (" + afterRename + ", " + afterBack + ")");
        }
        finally { await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(opened.Id), json), json); }

        // The pool regression: Select Top's column read leaves no pooled connection in the database, and ClearPoolsFor
        // closes the idle connections of the backend's per-database pools.
        var columns = await client.Call<TableColumnsResult>("tables.columns", new TableArgs(client.ConnectionId, db, "dbo", "Canary"));
        var sessions = $"SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE database_id = DB_ID({Literal(db)});";
        check(columns.Columns.Single().Name == "id" && (await Exec(sessions)).Scalar == "0", "tables.columns reads a table's columns without leaving a connection in its database");
        await using (var pooled = ((IExplorerHost)service).Connection(client.ConnectionId, db))
        {
            await pooled.OpenAsync();
        }
        var idle = (await Exec(sessions)).Scalar;
        service.ClearPoolsFor(client.ConnectionId, db);
        var cleared = (await Exec(sessions)).Scalar;
        check(idle == "1" && cleared == "0", "ClearPoolsFor closes the idle pooled connections in a database before its DDL (" + idle + " then " + cleared + ")");
        // Azure SQL Database's path (Object Explorer's per-database seam): the column read opens in the object's database.
        service.Explorer.Options.ForcePerDatabaseScope = true;
        TableColumnsResult perDatabase;
        try { perDatabase = await client.Call<TableColumnsResult>("tables.columns", new TableArgs(client.ConnectionId, db, "dbo", "Canary")); }
        finally { service.Explorer.Options.ForcePerDatabaseScope = false; }
        var inDatabase = (await Exec(sessions)).Scalar;
        service.ClearPoolsFor(client.ConnectionId, db);
        check(perDatabase.Columns.Single().Name == "id" && inDatabase == "1" && (await Exec(sessions)).Scalar == "0",
            "on Azure SQL Database's path tables.columns reads the columns in the object's database, with no cross-database call (" + inDatabase + " session there)");

        // Delete: in use by a query tab without Close existing connections, which keeps its backup history (that step runs
        // only after the DROP); with it, the tab's session ends and the database goes. Stop while msdb's history is locked
        // answers with what completed: the connections closed and the database dropped, the history kept.
        var history = $"SELECT COUNT(*) FROM msdb.dbo.backupset WHERE database_name = {Literal(db)};";
        async Task<SqlRun> Backup(string name) => await sql("DECLARE @device nvarchar(20) = CASE WHEN EXISTS (SELECT 1 FROM sys.all_objects WHERE name = N'dm_os_host_info') "
            + "AND (SELECT host_platform FROM sys.dm_os_host_info) = N'Linux' THEN N'/dev/null' ELSE N'NUL' END;\n"
            + "BACKUP DATABASE " + Bracket(name) + " TO DISK = @device WITH COPY_ONLY;", "master", null);
        var tab = Guid.NewGuid().ToString();
        var historyHolder = Guid.NewGuid().ToString();
        try
        {
            var inTab = await sql("SELECT 1;", db, tab);
            var backup = await Backup(db);
            var before = (await Exec(history)).Scalar;
            var inUse = await client.Delete(database, history: true);
            var kept = (await Exec(history)).Scalar;
            check(inTab.Status == "completed" && inUse is { Error.Code: "IN_USE" } && inUse.Steps.Select(step => step.Status).SequenceEqual(["failed", "skipped"])
                && inUse.Error.Message.Contains("Close its connections, or check Close existing connections.", StringComparison.Ordinal) && kept == before && (backup.Status != "completed" || before != "0"),
                "a database a query tab uses is IN_USE without Close existing connections, and its backup history is kept (" + before + " then " + kept + "; " + inUse.Error?.Message + ")");
            var locked = await sql("BEGIN TRANSACTION; SELECT COUNT(*) FROM msdb.dbo.backupset WITH (TABLOCKX, HOLDLOCK);", "msdb", historyHolder);
            using var context = new RequestContext(2, "actions.execute", RequestLane.Actions, 0);
            var dropping = client.Delete(database, close: true, history: true, context);
            var waitingOnHistory = false;
            for (var watch = Stopwatch.StartNew(); !waitingOnHistory && !dropping.IsCompleted && watch.ElapsedMilliseconds < 15_000; await Task.Delay(100))
                waitingOnHistory = (await Exec("SELECT COUNT(*) FROM sys.dm_exec_requests AS r JOIN sys.dm_exec_sessions AS s ON s.session_id = r.session_id WHERE s.host_process_id = " + Environment.ProcessId
                    + " AND s.program_name LIKE N'% - Object Actions' AND r.blocking_session_id <> 0 AND r.database_id = DB_ID(N'msdb');")).Scalar != "0";
            context.Cancel(CancelReason.User);
            ActionExecuteResult? stopped = null;
            try { stopped = await dropping; } catch (OperationCanceledException) { }
            var dropped = (await Exec("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar;
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(historyHolder), json), json);
            var left = (await Exec(history)).Scalar;
            check(locked.Status == "completed" && waitingOnHistory && stopped is { Error.Code: "CANCELLED" } && stopped.Steps.Select(step => step.Status).SequenceEqual(["done", "done", "cancelled"])
                && stopped.Error.Message.EndsWith("Completed before Stop: Close existing connections, Drop the database.", StringComparison.Ordinal) && dropped == "0" && left == before,
                "Stop during the backup history step answers with the steps that completed: connections closed and the database dropped, its history kept (" + stopped?.Error?.Message + ")");
        }
        finally
        {
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(historyHolder), json), json);
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(tab), json), json);
            // The history Stop left behind for the dropped name.
            await sql("EXEC msdb.dbo.sp_delete_database_backuphistory @database_name = " + Literal(db) + ";", "msdb", null);
        }

        // A second database (the renamed name, which the sweep also knows): Close existing connections and the history go too.
        var second = await scratch.CreateActionsRenamedAsync();
        var secondHistory = $"SELECT COUNT(*) FROM msdb.dbo.backupset WHERE database_name = {Literal(second)};";
        var secondBackup = await Backup(second);
        var secondBefore = (await Exec(secondHistory)).Scalar;
        var droppedSecond = await client.Delete(new ObjectRefDto("database", Name: second), close: true, history: true);
        var after = (await Exec(secondHistory)).Scalar;
        check(Done(droppedSecond) && droppedSecond.Steps.Count == 3 && (await Exec("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(second) + ";")).Scalar == "0" && after == "0"
            && (secondBackup.Status != "completed" || secondBefore != "0"), "with Close existing connections the database is dropped, then its backup history (" + secondBefore + " then " + after + ")");
    }
}
