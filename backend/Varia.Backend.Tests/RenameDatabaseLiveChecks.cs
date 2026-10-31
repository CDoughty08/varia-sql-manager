using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Activity;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of a database's rename (PR D3c, spec 7). Without scratch databases: SQL Server's own databases are refused
/// before any connection, and the server builds exactly the statements Script shows for hostile old and new names (7.6). With
/// VARIA_TEST_SQL_SCRATCH=1, in marked VariaScratch_…_ren, _renn and _rent databases: the describe reads the identity, access, sessions
/// and the logins whose default it is, leaving out the backend's own pools (7.7); with no session MODIFY NAME runs alone (7.1); Close
/// Connections and Rename rolls a holder back, renames and restores MULTI_USER under the new name, and the holder's tab is told its
/// session closed and then runs under the new name, while the old name no longer opens (7.2); Rename When Free waits for the holder until
/// Stop and changes nothing (7.3); a rename that fails after SINGLE_USER restores the access under the old name, and one stopped after
/// MODIFY NAME under the new one (7.4); RESTRICTED_USER comes back as it was (7.5); a database replaced since the describe is refused;
/// a sysadmin renames a database another session holds SINGLE_USER; and a dbcreator member with no user in the database is refused first.</summary>
internal static class RenameDatabaseLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title + (step.Compensates == true ? "(undo)" : "")));
    private const string ClosedNote = "The SQL session closed. The next execution opens a new session; previous SET options and temporary objects will be lost.";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        async Task<T> Call<T>(string method, object args, RequestContext? context = null) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json, context);
        Task<QueryResult> Run(string text, string database, string session) =>
            Call<QueryResult>("query.execute", new QueryArgs(info.Id, session, database, text, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true));
        async Task<SqlRun> Sql(string text, string database = "master", string? session = null)
        {
            var id = session ?? Guid.NewGuid().ToString();
            try
            {
                var result = await Run(text, database, id);
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
        Task<ActionDescribeResult> Describe(string name, string? connectionId = null) =>
            Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(connectionId ?? info.Id, Guid.NewGuid().ToString(), "renameDatabase", Database(name)));
        ActionArgs Rename(string from, string to, bool? close, DatabaseIdentityDto? identity = null, string? connectionId = null) =>
            new("rename", connectionId ?? info.Id, Guid.NewGuid().ToString(), Database(from), to, CloseConnections: close, Identity: identity);
        Task<ActionExecuteResult> Execute(ActionArgs args, RequestContext? context = null) => Call<ActionExecuteResult>("actions.execute", args, context);

        var refusals = new[]
        {
            await Refused(() => Describe("master")), await Refused(() => Execute(Rename("msdb", "msdb2", close: true))),
            await Refused(() => Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "renameDatabase", new ObjectRefDto("login", Name: "sa"))))
        };
        check(refusals.All(code => code == "INVALID_PARAMS"), "a database's rename and its describe refuse SQL Server's own databases and other kinds before any connection: " + string.Join(", ", refusals));

        // 7.6: for hostile old and new names at the sysname limit, SQL Server builds exactly each statement Script shows, and nothing runs.
        var mismatches = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'"))
        {
            var (from, to) = (ActionChecks.Long(fragment), ActionChecks.Long("]" + fragment));
            foreach (var access in new[] { 0, 2 })
                foreach (var statement in ActionService.RenameDatabasePlan(from, to, closeConnections: true, access))
                {
                    var selected = await service.Actions.DryRunAsync(info.Id, statement, CancellationToken.None);
                    if (!selected.SequenceEqual([ActionSql.Statement(statement)])) mismatches.Add(statement.Template + " " + fragment[..1]);
                }
        }
        check(mismatches.Count == 0, "SQL Server's QUOTENAME builds exactly the statements a database rename scripts (SINGLE_USER, MODIFY NAME, the access back) for hostile old and new names: "
            + string.Join(", ", mismatches));

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Database rename scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var db = await scratch.CreateRenameAsync();
        var renamed = scratch.Renamed;
        async Task<string?> State(string name) => (await Sql("SELECT state_desc + N' ' + user_access_desc FROM sys.databases WHERE name = " + Literal(name) + ";")).Scalar;
        var row = (await Sql("SELECT database_id, FORMAT(create_date, 'yyyy-MM-ddTHH:mm:ss.fff', 'en-US') FROM sys.databases WHERE name = " + Literal(db) + ";")).Sets[0][0];
        var identity = new DatabaseIdentityDto(int.Parse(row[0]!, CultureInfo.InvariantCulture), row[1]!);
        var pid = Environment.ProcessId.ToString(CultureInfo.InvariantCulture);

        // 7.7: a connection opened in the database leaves Object Explorer's idle pooled session there, which the describe frees first,
        // and Activity Monitor's pool sits in master: neither counts. 7.1: with no session MODIFY NAME runs alone, and that connection
        // follows the new name.
        var inside = await Call<ConnectionInfo>("connections.connect", live(db));
        try
        {
            var listed = await Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(inside.Id, Guid.NewGuid().ToString(), new NodeRefDto("folder", Owner: new ObjectRefDto("server"), Folder: "databases")));
            var explorerSessions = (await Sql("SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE database_id = DB_ID(" + Literal(db) + ") AND host_process_id = " + pid
                + " AND program_name LIKE N'% - Object Explorer';")).Scalar;
            ActionDescribeResult quiet;
            await using (var monitor = ((IActivityHost)service).MonitorConnection(inside.Id))
            {
                await monitor.OpenAsync();
                quiet = await Describe(db);
            }
            check(listed.Error is null && explorerSessions is not (null or "0") && quiet is { Error: null, RenameDatabase: { UserAccess: 0, Sessions: 0, WithTransaction: 0, LoginsDefaulting: 0, CanClose: true } facts }
                && facts.Identity == identity && facts.Name == db,
                "the rename's describe reads the database's identity and access, and counts no session once the backend's own pooled ones are freed; Activity Monitor's pool is in master ("
                + explorerSessions + ", " + quiet.Error?.Message + ", " + quiet.RenameDatabase?.Sessions + ")");
            var watch = Stopwatch.StartNew();
            var first = await Execute(Rename(db, renamed, close: false, identity));
            var elapsed = watch.ElapsedMilliseconds;
            var followed = await Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(inside.Id, Guid.NewGuid().ToString(), new NodeRefDto("folder", Owner: new ObjectRefDto("server"), Folder: "databases")));
            check(first.Error is null && Steps(first) == "done:Rename" && await State(renamed) == "ONLINE MULTI_USER" && await State(db) is null && elapsed < 10_000
                && followed.Error is null && followed.Nodes.Any(node => node.Label == renamed),
                "with no session, a database's rename runs MODIFY NAME alone, and a connection opened in it follows the new name (" + elapsed + " ms, " + first.Error?.Message + ")");
        }
        finally { await Call<object>("connections.disconnect", new ConnectionArgs(inside.Id)); }

        // 7.2: a query tab holding an open transaction in the database. Close Connections and Rename rolls it back, renames, and restores
        // MULTI_USER under the new name; the tab is told its session closed, and its next run under the new name opens a session there.
        var holder = Guid.NewGuid().ToString();
        try
        {
            var held = await Sql("BEGIN TRANSACTION; CREATE TABLE dbo.Held (id int); SELECT @@SPID;", renamed, holder);
            var busy = await Describe(renamed);
            check(held.Status == "completed" && busy is { Error: null, RenameDatabase: { Sessions: 1, WithTransaction: 1 } },
                "the describe counts the session in the database and its open transaction (critic A7) (" + busy.Error?.Message + ", " + busy.RenameDatabase?.Sessions + ")");
            var replaced = await Execute(Rename(renamed, db, close: true, identity with { Id = identity.Id + 100_000 }));
            check(replaced is { Error.Code: "NOT_FOUND" } && replaced.Steps.Count == 0 && await State(renamed) == "ONLINE MULTI_USER",
                "a database other than the one the describe read is refused before any step (" + replaced.Error?.Message + ")");
            var closed = await Execute(Rename(renamed, db, close: true, busy.RenameDatabase!.Identity));
            var killed = await Run("SELECT 1;", db, holder);
            var oldName = await Sql("SELECT 1;", renamed);
            var reopened = await Run("SELECT DB_NAME(), @@TRANCOUNT, OBJECT_ID(N'dbo.Held');", db, holder);
            var after = reopened.Status == "completed" ? LiveResultChecks.RowsOf(service.Results, reopened.ResultSets[0])[0] : [];
            check(closed.Error is null && Steps(closed) == "done:Close existing connections, done:Rename, done:Restore multi-user access" && await State(db) == "ONLINE MULTI_USER" && await State(renamed) is null
                && killed.Status == "failed" && LiveResultChecks.Texts(killed).Contains(ClosedNote) && oldName.Status != "completed" && oldName.Error?.Contains("4060", StringComparison.Ordinal) == true
                && after is [var name, "0", null] && name == db,
                "Close Connections and Rename rolls the holder back, renames, and restores MULTI_USER under the new name; the holder's tab is told its session closed, its next run under the new name opens one there, and the old name no longer opens ("
                + Steps(closed) + ", " + closed.Error?.Message + " | " + killed.Status + " | " + oldName.Error + ")");
        }
        finally { await Call<object>("query.session.close", new SessionArgs(holder)); }

        // 7.3: Rename When Free waits for a session in the database (SQL Server 2025, as probed) until Stop, or fails at once that it is
        // in use; either way the name and the session's transaction stay.
        var waiter = Guid.NewGuid().ToString();
        try
        {
            await Sql("BEGIN TRANSACTION; CREATE TABLE dbo.Waiting (id int);", db, waiter);
            using var context = new RequestContext(1, "actions.execute", RequestLane.Actions, 0);
            var waiting = Execute(Rename(db, renamed, close: false), context);
            var stillWaiting = !await Task.WhenAny(waiting, Task.Delay(2000)).ContinueWith(done => done.Result == waiting);
            context.Cancel(CancelReason.User);
            ActionExecuteResult? stopped = null;
            try { stopped = await waiting; } catch (OperationCanceledException) { }
            var open = (await Sql("SELECT @@TRANCOUNT;", db, waiter)).Scalar;
            var outcome = stopped is null ? "unknown" : Steps(stopped) + ", " + stopped.Error?.Code;
            check((stillWaiting ? stopped is { Error.Code: "CANCELLED" } && Steps(stopped) == "cancelled:Rename" : stopped is { Error.Code: "IN_USE" } && Steps(stopped) == "failed:Rename")
                && await State(db) == "ONLINE MULTI_USER" && await State(renamed) is null && open == "1",
                "Rename When Free waits for another session until Stop, or fails that the database is in use; the name and that session's transaction stay (" + (stillWaiting ? "waited" : "failed at once") + ", " + outcome + ")");
        }
        finally { await Call<object>("query.session.close", new SessionArgs(waiter)); }

        // 7.4: a rename that fails after SINGLE_USER (the name was taken after the preflight read it, 1801) restores MULTI_USER under the old
        // name; one stopped once MODIFY NAME completed restores it under the new name.
        string? taken = null;
        service.Actions.Options.BeforeStep = async (title, _) => { if (title == "Rename" && taken is null) taken = await scratch.CreateRenameTakenAsync(); };
        ActionExecuteResult collided;
        try { collided = await Execute(Rename(db, scratch.RenameTaken, close: true)); }
        finally { service.Actions.Options.BeforeStep = null; }
        check(taken is not null && collided is { Error.Code: "NAME_IN_USE" } && Steps(collided) == "done:Close existing connections, failed:Rename, skipped:Restore multi-user access, done:Restore multi-user access(undo)"
            && collided.Error.Message.Contains("Then \"Restore multi-user access\" completed", StringComparison.Ordinal) && await State(db) == "ONLINE MULTI_USER",
            "a rename that fails after SINGLE_USER restores MULTI_USER under the old name, and says so (" + Steps(collided) + ", " + collided.Error?.Message + ")");
        ActionExecuteResult? late = null;
        using (var context = new RequestContext(1, "actions.execute", RequestLane.Actions, 0))
        {
            service.Actions.Options.AfterStep = title => { if (title == "Rename") context.Cancel(CancelReason.User); };
            try { late = await Execute(Rename(db, renamed, close: true), context); }
            catch (OperationCanceledException) { }
            finally { service.Actions.Options.AfterStep = null; }
        }
        check(late is { Error.Code: "CANCELLED" } && Steps(late) == "done:Close existing connections, done:Rename, cancelled:Restore multi-user access, done:Restore multi-user access(undo)"
            && await State(renamed) == "ONLINE MULTI_USER" && await State(db) is null,
            "a rename stopped once MODIFY NAME completed restores MULTI_USER under the new name (" + (late is null ? "unknown outcome" : Steps(late) + ", " + late.Error?.Message) + ")");

        // 7.5: a RESTRICTED_USER database comes back RESTRICTED_USER, under its new name.
        var restricted = await Sql("ALTER DATABASE " + Bracket(renamed) + " SET RESTRICTED_USER;");
        var restrictedFacts = await Describe(renamed);
        var back = await Execute(Rename(renamed, db, close: true));
        check(restricted.Status == "completed" && restrictedFacts.RenameDatabase?.UserAccess == 2 && back.Error is null
            && Steps(back) == "done:Close existing connections, done:Rename, done:Restore restricted user access" && await State(db) == "ONLINE RESTRICTED_USER",
            "a RESTRICTED_USER database is renamed back to RESTRICTED_USER (" + Steps(back) + ", " + back.Error?.Message + ")");
        await Sql("ALTER DATABASE " + Bracket(db) + " SET MULTI_USER;");

        // Script runs nothing and shows the plan's main statements.
        var script = await Call<ActionScriptResult>("actions.script", Rename(db, renamed, close: true));
        check(script is { Error: null, Database: "master" } && script.Text == ActionService.ScriptText(ActionService.RenameDatabasePlan(db, renamed, true, 0)) && await State(db) == "ONLINE MULTI_USER",
            "Script Action shows SINGLE_USER, MODIFY NAME and MULTI_USER and runs nothing");

        // Another session holds the database SINGLE_USER: HAS_PERMS_BY_NAME on it answers 0 even to sysadmin, which may still rename it.
        // SET SINGLE_USER again would fail (5064), so Close Connections and Rename runs MODIFY NAME alone, which SQL Server 2025 completes
        // with the session inside (probed); the access stays SINGLE_USER.
        await Sql("ALTER DATABASE " + Bracket(db) + " SET SINGLE_USER;");
        var occupant = Guid.NewGuid().ToString();
        try
        {
            var inSingle = await Sql("SELECT @@SPID;", db, occupant);
            var occupied = await Describe(db);
            var single = await Execute(Rename(db, renamed, close: true, occupied.RenameDatabase?.Identity));
            var name = await State(renamed) is null ? db : renamed;
            check(inSingle.Status == "completed" && occupied is { Error: null, RenameDatabase: { UserAccess: 1, Sessions: 1 } } && single.Steps.All(step => step.Title == "Rename")
                && single.Steps.Count == 1 && (single.Error is null ? name == renamed : single.Error.Code is "IN_USE" or "SQL_ERROR") && await State(name) == "ONLINE SINGLE_USER",
                "a sysadmin renames a SINGLE_USER database another session holds with MODIFY NAME alone, and its access stays SINGLE_USER (" + occupied.Error?.Message + " | " + Steps(single) + ", " + single.Error?.Message + ")");
            await Call<object>("query.session.close", new SessionArgs(occupant));
            await Sql("ALTER DATABASE " + Bracket(name) + " SET MULTI_USER;");
            if (name == renamed) await Sql("ALTER DATABASE " + Bracket(renamed) + " MODIFY NAME = " + Bracket(db) + ";");
        }
        finally { await Call<object>("query.session.close", new SessionArgs(occupant)); }

        // A login whose default database it is, and a dbcreator member with no user in the database, which MODIFY NAME refuses (916, as it
        // must open the database) although it may take the database offline: the preflight refuses it before SINGLE_USER.
        if (await scratch.CreateLoginAsync())
        {
            await Sql("ALTER LOGIN " + Bracket(scratch.Login!) + " WITH DEFAULT_DATABASE = " + Bracket(db) + ";");
            var defaulting = await Describe(db);
            await Sql("ALTER LOGIN " + Bracket(scratch.Login!) + " WITH DEFAULT_DATABASE = [master];");
            check(defaulting.RenameDatabase?.LoginsDefaulting == 1, "the describe counts the logins whose default database it is (" + defaulting.RenameDatabase?.LoginsDefaulting + ")");
            var low = await Call<ConnectionInfo>("connections.connect", live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password });
            try
            {
                var lowFacts = await Describe(db, low.Id);
                var refused = await Execute(Rename(db, renamed, close: false, connectionId: low.Id));
                check(lowFacts.Error?.Code == "PERMISSION_DENIED" && refused is { Error.Code: "PERMISSION_DENIED" } && refused.Steps.Count == 0 && await State(db) == "ONLINE MULTI_USER",
                    "a login without ALTER on the database cannot rename it (" + lowFacts.Error?.Code + ", " + refused.Error?.Message + ")");
            }
            finally { await Call<object>("connections.disconnect", new ConnectionArgs(low.Id)); }
            var granted = await Sql("ALTER SERVER ROLE [dbcreator] ADD MEMBER " + Bracket(scratch.Login!) + ";");
            var creator = await Call<ConnectionInfo>("connections.connect", live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password });
            try
            {
                var creatorFacts = await Describe(db, creator.Id);
                var refused = await Execute(Rename(db, renamed, close: true, connectionId: creator.Id));
                check(granted.Status == "completed" && creatorFacts.Error?.Code == "PERMISSION_DENIED" && refused is { Error.Code: "PERMISSION_DENIED" } && refused.Steps.Count == 0
                    && await State(db) == "ONLINE MULTI_USER",
                    "a dbcreator member with no user in the database is refused before SINGLE_USER, as MODIFY NAME would fail (" + creatorFacts.Error?.Message + " | " + refused.Error?.Message + ")");
            }
            finally
            {
                await Call<object>("connections.disconnect", new ConnectionArgs(creator.Id));
                await Sql("ALTER SERVER ROLE [dbcreator] DROP MEMBER " + Bracket(scratch.Login!) + ";");
            }
        }
        else Console.WriteLine("Database rename permission checks skipped: the server accepts Windows logins only.");
    }
}
