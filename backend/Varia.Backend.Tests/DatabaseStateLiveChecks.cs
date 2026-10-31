using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of Tasks › Take Offline and Bring Online (PR D3a). Without scratch databases: SQL Server's own databases
/// are refused before any connection reads them. With VARIA_TEST_SQL_SCRATCH=1, in a marked VariaScratch_…_dbs database: the
/// describe reads the database's identity, state and the sessions in it without the backend's own pooled ones, and the session
/// holding an open transaction (critic A7); SET OFFLINE waits for that session until Stop, which leaves the database online and
/// the transaction open; with Drop All Active Connections it rolls the session back and goes offline; the state rules refuse
/// what the menu greys; a database replaced since the dialog read it is refused; Script runs nothing; and Bring Online brings it
/// back, saying when it is still SINGLE_USER. The hostile-name dry runs of the three templates are ActionLiveChecks' loop.</summary>
internal static class DatabaseStateLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static NodeRefDto Folder(string folder) => new("folder", Owner: new ObjectRefDto("server"), Folder: folder);
    private static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title));

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        async Task<T> Call<T>(string method, object args, RequestContext? context = null) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json, context);
        async Task<SqlRun> Sql(string text, string database = "master", string? session = null)
        {
            var id = session ?? Guid.NewGuid().ToString();
            try
            {
                var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true));
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { if (session is null) await Call<object>("query.session.close", new SessionArgs(id)); }
        }
        async Task<string> Refused(Func<Task> call)
        {
            try { await call(); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        ObjectRefDto Database(string name) => new("database", Name: name);
        Task<ActionDescribeResult> Describe(string dialog, string name, string? connectionId = null) =>
            Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(connectionId ?? info.Id, Guid.NewGuid().ToString(), dialog, Database(name)));
        ActionArgs TakeOffline(string name, bool drop, DatabaseIdentityDto? identity = null, string? connectionId = null) =>
            new("takeOffline", connectionId ?? info.Id, Guid.NewGuid().ToString(), Database(name), Identity: identity, DropConnections: drop);
        ActionArgs BringOnline(string name, DatabaseIdentityDto? identity = null) => new("bringOnline", info.Id, Guid.NewGuid().ToString(), Database(name), Identity: identity);
        Task<ActionExecuteResult> Execute(ActionArgs args, RequestContext? context = null) => Call<ActionExecuteResult>("actions.execute", args, context);

        // SQL Server's own databases never reach a connection.
        var refusals = new[]
        {
            await Refused(() => Describe("takeOffline", "master")), await Refused(() => Describe("bringOnline", "tempdb")),
            await Refused(() => Execute(TakeOffline("msdb", drop: true))), await Refused(() => Execute(BringOnline("model")))
        };
        check(refusals.All(code => code == "INVALID_PARAMS"), "Take Offline and Bring Online refuse SQL Server's own databases before any connection: " + string.Join(", ", refusals));

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Take Offline and Bring Online scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var db = await scratch.CreateDatabaseStateAsync();
        async Task<string?> State() => (await Sql("SELECT state_desc + N' ' + user_access_desc FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar;
        var row = (await Sql("SELECT database_id, FORMAT(create_date, 'yyyy-MM-ddTHH:mm:ss.fff', 'en-US') FROM sys.databases WHERE name = " + Literal(db) + ";")).Sets[0][0];
        var identity = new DatabaseIdentityDto(int.Parse(row[0]!, CultureInfo.InvariantCulture), row[1]!);

        // The describe: identity and state, no sessions, and Bring Online refused on an online database with the menu's reason.
        var quiet = await Describe("takeOffline", db);
        var onlineRefused = await Describe("bringOnline", db);
        check(quiet is { Error: null, DatabaseState: { State: 0, UserAccess: 0, ReadOnly: false, Standby: false, Sessions: 0, WithTransaction: 0, SessionsTruncated: false } state }
            && state.Identity == identity && state.Name == db && state.SessionList.Count == 0 && state.Warnings.Count == 0
            && onlineRefused is { DatabaseState: null, Error: { Code: "NOT_SUPPORTED", Message: "The database is online." } },
            "Take Database Offline reads the database's identity (database_id, create_date), state and its sessions; Bring Online refuses an online database as the menu greys it ("
            + quiet.Error?.Message + ")");

        // A connection opened in the database leaves Object Explorer's idle pooled session there, which the describe leaves out (the
        // action frees it), and a query tab with an open transaction, which it lists (critic A7).
        await Sql("CREATE TABLE dbo.Held (id int);", db);
        var inside = await Call<ConnectionInfo>("connections.connect", live(db));
        var holder = Guid.NewGuid().ToString();
        var offline = false;
        try
        {
            var listed = await Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(inside.Id, Guid.NewGuid().ToString(), Folder("databases")));
            var pid = Environment.ProcessId.ToString(CultureInfo.InvariantCulture);
            var explorerSessions = (await Sql("SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE database_id = DB_ID(" + Literal(db) + ") AND host_process_id = " + pid
                + " AND program_name LIKE N'% - Object Explorer';")).Scalar;
            var held = await Sql("BEGIN TRANSACTION; INSERT dbo.Held VALUES (1); SELECT @@SPID;", db, holder);
            var spid = int.Parse(held.Scalar!, CultureInfo.InvariantCulture);
            var busy = await Describe("takeOffline", db);
            var listedSession = busy.DatabaseState?.SessionList.FirstOrDefault(session => session.SessionId == spid);
            check(listed.Error is null && explorerSessions is not (null or "0") && busy is { Error: null, DatabaseState: { Sessions: 1, WithTransaction: 1, SessionsTruncated: false } }
                && busy.DatabaseState.SessionList.Count == 1 && listedSession is { OpenTransactions: 1, Program: not null, Login: not null },
                "the describe lists the session with an open transaction and leaves out the backend's own pooled Object Explorer session (" + explorerSessions + ", "
                + busy.DatabaseState?.Sessions + ", " + busy.Error?.Message + ")");

            // Without Drop All Active Connections, SET OFFLINE waits for the session as SSMS's does, until Stop cancels it in SQL Server.
            using (var context = new RequestContext(1, "actions.execute", RequestLane.Actions, 0))
            {
                var waiting = Execute(TakeOffline(db, drop: false, identity), context);
                var stillWaiting = !await Task.WhenAny(waiting, Task.Delay(2000)).ContinueWith(done => done.Result == waiting);
                var blocked = (await Sql("SELECT CONVERT(nvarchar(20), s.lock_timeout) + N' ' + r.wait_type FROM sys.dm_exec_requests AS r JOIN sys.dm_exec_sessions AS s ON s.session_id = r.session_id "
                    + "WHERE s.host_process_id = " + pid + " AND s.program_name LIKE N'% - Object Actions' AND r.blocking_session_id <> 0;")).Scalar;
                var watch = Stopwatch.StartNew();
                context.Cancel(CancelReason.User);
                ActionExecuteResult? stopped = null;
                try { stopped = await waiting; } catch (OperationCanceledException) { }
                var answeredMs = watch.ElapsedMilliseconds;
                var open = (await Sql("SELECT @@TRANCOUNT;", db, holder)).Scalar;
                check(stillWaiting && blocked?.StartsWith("-1 LCK_M_", StringComparison.Ordinal) == true && stopped is { Error.Code: "CANCELLED" } && Steps(stopped) == "cancelled:Take database offline"
                    && answeredMs < 10_000 && await State() == "ONLINE MULTI_USER" && open == "1",
                    "SET OFFLINE waits for another session without a timeout, and Stop answers once SQL Server cancelled it: the database stays online and the session keeps its transaction ("
                    + blocked + ", " + answeredMs + " ms, " + (stopped is null ? "unknown outcome" : Steps(stopped)) + ")");
            }

            // Script Action shows the statement and runs nothing.
            var script = await Call<ActionScriptResult>("actions.script", TakeOffline(db, drop: true));
            var nl = Environment.NewLine;
            check(script is { Error: null, Database: "master" } && script.Text == "USE [master]" + nl + "GO" + nl + "ALTER DATABASE " + Bracket(db) + " SET  OFFLINE WITH ROLLBACK IMMEDIATE" + nl + "GO" + nl
                && await State() == "ONLINE MULTI_USER", "Script Action returns SSMS's SET OFFLINE WITH ROLLBACK IMMEDIATE and runs nothing");

            // With Drop All Active Connections: the session is rolled back and the database goes offline.
            var watchDrop = Stopwatch.StartNew();
            var dropped = await Execute(TakeOffline(db, drop: true, identity));
            offline = await State() == "OFFLINE MULTI_USER";
            var after = await Sql("SELECT 1;", db, holder);
            check(dropped.Error is null && Steps(dropped) == "done:Close connections and take database offline" && offline && after.Status != "completed" && watchDrop.Elapsed < TimeSpan.FromSeconds(60),
                "Drop All Active Connections rolls the other session back and takes the database offline (" + watchDrop.ElapsedMilliseconds + " ms, " + dropped.Error?.Message + ")");
            var listedOffline = await Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(inside.Id, Guid.NewGuid().ToString(), Folder("databases")));
            check(listedOffline.Error is null && listedOffline.Nodes.Any(node => node.Label == db), "Object Explorer still lists databases on a connection opened in the database it took offline");

            // The state rules refuse what the menu greys, and Bring Online's describe reads the offline database.
            var again = await Execute(TakeOffline(db, drop: false));
            var describedAgain = await Describe("takeOffline", db);
            var bring = await Describe("bringOnline", db);
            check(again is { Error: { Code: "NOT_SUPPORTED", Message: "The database is offline." } } && again.Steps.Count == 0 && describedAgain.Error?.Message == "The database is offline."
                && bring is { Error: null, DatabaseState: { State: 6, Sessions: 0 } } && bring.DatabaseState.Identity == identity,
                "Take Offline is refused on an offline database, with the menu's reason, and Bring Online's describe reads it (" + again.Error?.Message + " | " + describedAgain.Error?.Message + " | " + bring.Error?.Message + " | " + bring.DatabaseState?.State + "/" + bring.DatabaseState?.Sessions + "/" + bring.DatabaseState?.Identity + ")");

            // A database other than the one the dialog read is refused.
            var replaced = await Execute(BringOnline(db, identity with { Id = identity.Id + 100_000 }));
            check(replaced is { Error.Code: "NOT_FOUND" } && replaced.Steps.Count == 0 && await State() == "OFFLINE MULTI_USER",
                "Bring Online refuses a database that is not the one its dialog read, and changes nothing");

            // SINGLE_USER set while offline stays after SET ONLINE, which the reply says.
            var single = await Sql("ALTER DATABASE " + Bracket(db) + " SET SINGLE_USER;");
            var online = await Execute(BringOnline(db, identity));
            offline = await State() is not "ONLINE SINGLE_USER";
            check(single.Status == "completed" && online.Error is null && Steps(online) == "done:Bring database online" && !offline
                && online.Messages.Any(message => message.Contains("SINGLE_USER", StringComparison.Ordinal)),
                "Bring Online runs SET ONLINE and says when the database is still SINGLE_USER (" + online.Error?.Message + ", " + string.Join(" | ", online.Messages) + ")");
            await Sql("ALTER DATABASE " + Bracket(db) + " SET MULTI_USER;");
            var plain = await Execute(TakeOffline(db, drop: false, identity));
            var back = await Execute(BringOnline(db));
            check(plain.Error is null && Steps(plain) == "done:Take database offline" && back.Error is null && back.Messages.Count == 0 && await State() == "ONLINE MULTI_USER",
                "with no other session, SET OFFLINE needs no Drop All Active Connections, and Bring Online of a multi-user database says nothing more");
        }
        finally
        {
            if (offline) await Sql("ALTER DATABASE " + Bracket(db) + " SET ONLINE;");
            await Call<object>("query.session.close", new SessionArgs(holder));
            await Call<object>("connections.disconnect", new ConnectionArgs(inside.Id));
        }

        // A login without ALTER on the database or VIEW SERVER STATE: refused before any DDL, and the database stays online.
        if (await scratch.CreateLoginAsync())
        {
            var low = await Call<ConnectionInfo>("connections.connect", live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password });
            try
            {
                var described = await Describe("takeOffline", db, low.Id);
                var executed = await Execute(TakeOffline(db, drop: true, connectionId: low.Id));
                check(executed is { Error.Code: "PERMISSION_DENIED" } && executed.Steps.Count == 0 && await State() == "ONLINE MULTI_USER"
                    && (described is { Error.Code: "PERMISSION_DENIED" } || described is { Error: null, DatabaseState.Sessions: null }),
                    "a login without ALTER on the database cannot take it offline, and sees no session counts without VIEW SERVER STATE (" + described.Error?.Code + ", " + executed.Error?.Message + ")");
            }
            finally { await Call<object>("connections.disconnect", new ConnectionArgs(low.Id)); }
        }
        else Console.WriteLine("Take Offline permission checks skipped: the server accepts Windows logins only.");
    }
}
