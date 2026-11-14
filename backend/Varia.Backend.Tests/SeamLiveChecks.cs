using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Activity;

namespace Varia.Backend.Tests;

/// <summary>Live checks of wave 5's backend seams (PR W5-0b). Without scratch databases: the login preflight reads sa and the
/// connection's own login, and Object Explorer gives logins their subtypes. With VARIA_TEST_SQL_SCRATCH=1, in marked
/// VariaScratch_…_seam and _seamt databases and the scratch SQL login: runner v2 undoes a completed SET SINGLE_USER after a rename
/// fails and after Stop, whose reply waits for the cleanup budget, and a compensation past that budget is cancelled (critic A4); the
/// shared templates run for real (A21); and freeing the database, through another connection to the server or for a login whose
/// default database it is (Database <default>), moves the server-scope pools to master and ends Varia's pooled sessions there, so it
/// goes offline at once while Object Explorer still lists databases (A5). The hostile-name dry runs of
/// the shared templates are ActionLiveChecks' loop over every template.</summary>
internal static class SeamLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static NodeRefDto Folder(string folder) => new("folder", Owner: new ObjectRefDto("server"), Folder: folder);

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<SqlRun> Sql(string text, string database = "master", int timeout = 300)
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, timeout, StopOnError: true));
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await Call<object>("query.session.close", new SessionArgs(id)); }
        }
        async Task<List<ExplorerNode>> Listing(string connectionId, string folder)
        {
            var nodes = new List<ExplorerNode>();
            string? cursor = null;
            do
            {
                var page = await Call<ExplorerChildrenResult>("explorer.children", new ExplorerChildrenArgs(connectionId, Guid.NewGuid().ToString(), Folder(folder), Cursor: cursor));
                if (page.Error is not null) throw new InvalidOperationException("Listing " + folder + " failed: " + page.Error.Message);
                nodes.AddRange(page.Nodes);
                cursor = page.Cursor;
            } while (cursor is not null);
            return nodes;
        }
        var actions = service.Actions;
        var rules = actions.Catalog.Logins;

        // The login preflight in the action's own connection, and Object Explorer's subtypes: sa by principal_id, the own login.
        var sa = (await Sql("SELECT name FROM sys.server_principals WHERE principal_id = 1;")).Scalar!;
        var own = (await Sql("SELECT TOP (1) p.name FROM sys.login_token AS t JOIN sys.server_principals AS p ON p.principal_id = t.principal_id "
            + "WHERE t.usage = N'GRANT OR DENY' AND p.type IN ('S', 'U', 'G') ORDER BY CASE p.type WHEN 'G' THEN 1 ELSE 0 END, p.name;")).Scalar;
        var saFacts = await actions.LoginFactsAsync(info.Id, sa, CancellationToken.None);
        var ownFacts = own is null ? null : await actions.LoginFactsAsync(info.Id, own, CancellationToken.None);
        check(saFacts is { PrincipalId: 1, Subtype: "sa", Type: "S", Sid: "01", CanAlter: true } && saFacts.Created.Length == 23 && rules.Refusal(saFacts, "delete") == "saDelete"
            && ownFacts is { Own: true } && rules.Refusal(ownFacts, "rename") == "own" && await actions.LoginFactsAsync(info.Id, "sysadmin", CancellationToken.None) is null,
            "the login preflight reads sa by principal_id and the connection's own login (sys.login_token), and refuses what the rules refuse; a server role is not a login");
        var logins = await Listing(info.Id, "logins");
        check(logins.Any(node => node is { Label: var label, Subtype: "sa", Icon: "login" } && label == sa) && (own is null || logins.Any(node => node.Label == own && node.Subtype is "sa" or "sql" or "windowsUser" or "windowsGroup"))
            && logins.All(node => node.Subtype is not null && rules.Subtypes.Contains(node.Subtype)),
            "Object Explorer gives every login the subtype the login rules derive, sa by principal_id");

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Wave 5 seam scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping uniquely named databases and a login on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var db = await scratch.CreateSeamAsync();
        var taken = scratch.SeamTaken;
        async Task<string?> Access() => (await Sql("SELECT user_access_desc FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar;
        List<PlannedStatement> Plan(string newName) =>
        [
            new(ActionTemplate.SetSingleUser, "master", [db]), new(ActionTemplate.RenameDatabase, "master", [db, newName]),
            new(ActionTemplate.SetMultiUser, "master", [db], StepKind.Compensation, Undoes: 0)
        ];
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title + (step.Compensates == true ? "*" : "")));

        // Runner v2 on a forced failure: the rename collides, so the completed SET SINGLE_USER is undone.
        var failed = await actions.ExecutePlanAsync(info.Id, Guid.NewGuid().ToString(), "delete", Plan(taken), CancellationToken.None);
        check(Steps(failed) == "done:Close existing connections, failed:Rename, done:Restore multi-user access*" && failed.Error is { Code: "NAME_IN_USE" } error
            && error.Message.EndsWith(" Then \"Restore multi-user access\" completed.", StringComparison.Ordinal) && await Access() == "MULTI_USER",
            "a failed rename after SET SINGLE_USER runs the compensation, which restores multi-user access and says so: " + Steps(failed) + " | " + failed.Error?.Message);

        // And on Stop: the hook stops the request before the rename starts, as the dialog's Stop would while it waits. StopGrace is cut
        // to a millisecond and the compensation held for 1.5 s, so only the cleanup budget the reply also waits for (critic A4) lets
        // it list the compensation rather than answer an unknown outcome.
        var grace = actions.Options.StopGrace;
        using (var stop = new CancellationTokenSource())
        {
            actions.Options.BeforeStep = (title, _) => { if (title == "Rename") stop.Cancel(); return Task.CompletedTask; };
            actions.Options.BeforeCleanup = (_, token) => Task.Delay(1500, token);
            actions.Options.StopGrace = TimeSpan.FromMilliseconds(1);
            try
            {
                ActionExecuteResult? stopped = null;
                try { stopped = await actions.ExecutePlanAsync(info.Id, Guid.NewGuid().ToString(), "delete", Plan(db + "x"), stop.Token); }
                catch (OperationCanceledException) { }
                check(stopped is not null && Steps(stopped) == "done:Close existing connections, cancelled:Rename, done:Restore multi-user access*" && stopped.Error is { Code: "CANCELLED" } cancelled
                    && cancelled.Message.Contains("Completed before Stop: Close existing connections.", StringComparison.Ordinal) && cancelled.Message.EndsWith(" Then \"Restore multi-user access\" completed.", StringComparison.Ordinal)
                    && await Access() == "MULTI_USER" && (await Sql("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(db + "x") + ";")).Scalar == "0",
                    "Stop after SET SINGLE_USER still undoes it before the reply, which waits for the cleanup budget and lists the compensation: "
                    + (stopped is null ? "the reply answered an unknown outcome" : Steps(stopped)));
            }
            finally
            {
                actions.Options.BeforeStep = null;
                actions.Options.BeforeCleanup = null;
                actions.Options.StopGrace = grace;
            }
        }

        // A compensation that outlives its cleanup budget is cancelled under that budget's own token (not the job's, which no Stop
        // cancelled here), and the reply says it did not finish.
        await using (var connection = ((IActionHost)service).Connection(info.Id))
        {
            await ((IActionHost)service).OpenAsync(connection, CancellationToken.None);
            RunStep Batch(string title, string sql, StepKind kind = StepKind.Main, int? undoes = null) => new(title, async context =>
            {
                await using var command = new SqlCommand(sql, connection) { CommandTimeout = 0 };
                await command.ExecuteNonQueryAsync(context.Token);
            }, kind, undoes);
            var watch = System.Diagnostics.Stopwatch.StartNew();
            var outcome = await actions.RunStepsAsync(connection,
                [Batch("Prepare", "SELECT 1;"), Batch("Fail", "THROW 50000, N'Forced failure.', 1;"), Batch("Undo", "WAITFOR DELAY '00:00:30';", StepKind.Compensation, 0)],
                null, CancellationToken.None, TimeSpan.FromSeconds(1));
            var seconds = watch.Elapsed.TotalSeconds;
            check(outcome.Steps.Select(step => step.Status + ":" + step.Title + (step.Compensates == true ? "*" : "")).SequenceEqual(["done:Prepare", "failed:Fail", "cancelled:Undo*"])
                && outcome.Failure is { } expired && expired.Message.EndsWith(" Then \"Undo\" did not finish within 1 seconds.", StringComparison.Ordinal) && seconds < 20,
                "a compensation past its cleanup budget is cancelled by that budget and listed as not finished ("
                + string.Join(", ", outcome.Steps.Select(step => step.Status + ":" + step.Title)) + ", " + seconds.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " s)");
        }

        // The shared templates for real: restricted user and back, and a login's DISABLE, ENABLE, DENY and GRANT CONNECT SQL, DROP USER.
        async Task<ActionExecuteResult> Run(params PlannedStatement[] plan) => await actions.ExecutePlanAsync(info.Id, Guid.NewGuid().ToString(), "delete", plan, CancellationToken.None);
        // The sessions of this process in the database (query tabs here run in master).
        var pid = Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        string Ours(string suffix) => "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE database_id = DB_ID(" + Literal(db) + ") AND host_process_id = " + pid
            + (suffix.Length == 0 ? "" : " AND program_name LIKE N'%" + suffix + "'") + ";";
        var restricted = await Run(new PlannedStatement(ActionTemplate.SetRestrictedUser, "master", [db]));
        var restrictedAccess = await Access();
        var multi = await Run(new PlannedStatement(ActionTemplate.SetMultiUser, "master", [db]));
        check(restricted.Error is null && restrictedAccess == "RESTRICTED_USER" && multi.Error is null && await Access() == "MULTI_USER",
            "SET  RESTRICTED_USER and SET  MULTI_USER run as Script Action shows them");
        if (await scratch.CreateLoginAsync())
        {
            var login = scratch.Login!;
            var facts = await actions.LoginFactsAsync(info.Id, login, CancellationToken.None);
            check(facts is { Subtype: "sql", Type: "S", Own: false, Disabled: false, ConnectDenied: false, PolicyChecked: false, Sysadmin: false, OwnedDatabases: 0, OwnedServerObjects: 0, NameInUse: false }
                && facts.Sid.Length is > 2 and <= 172 && facts.OwnedDatabaseNames.Count == 0 && rules.Refusal(facts, "disable") is null && rules.Refusal(facts, "unlock") is null,
                "the login preflight reads a SQL login's type, state, SID, policy flags and permissions from catalog views");
            var disabled = await Run(new PlannedStatement(ActionTemplate.DisableLogin, "master", [login]), new PlannedStatement(ActionTemplate.DenyConnect, "master", [login]));
            var changed = await actions.LoginFactsAsync(info.Id, login, CancellationToken.None);
            var enabled = await Run(new PlannedStatement(ActionTemplate.EnableLogin, "master", [login]), new PlannedStatement(ActionTemplate.GrantConnect, "master", [login]));
            var restored = await actions.LoginFactsAsync(info.Id, login, CancellationToken.None);
            check(Steps(disabled) == "done:Disable the login, done:Deny permission to connect" && changed is { Disabled: true, ConnectDenied: true }
                && Steps(enabled) == "done:Enable the login, done:Grant permission to connect" && restored is { Disabled: false, ConnectDenied: false },
                "ALTER LOGIN DISABLE and ENABLE and DENY and GRANT CONNECT SQL change only what they name");
            var user = await Sql("CREATE USER " + Bracket(login) + " FOR LOGIN " + Bracket(login) + ";", db);
            var dropped = await Run(new PlannedStatement(ActionTemplate.DropUser, db, [login]));
            check(user.Status == "completed" && Steps(dropped) == "done:Drop the database user"
                && (await Sql("SELECT COUNT(*) FROM sys.database_principals WHERE name = " + Literal(login) + ";", db)).Scalar == "0",
                "DROP USER runs in its own database");

            // Critic A5 with the Connect dialog's <default>: the login's default database is the seam database, so the connect's pool
            // and Object Explorer's server-scope pool open there with no Initial Catalog to say so. This login lacks VIEW SERVER STATE,
            // so its action sees no sessions to wait for; the check waits (up to 5 s) for the cleared ones to end.
            await Sql("ALTER LOGIN " + Bracket(login) + " WITH DEFAULT_DATABASE = " + Bracket(db) + ";");
            await Sql("CREATE USER " + Bracket(login) + " FOR LOGIN " + Bracket(login) + ";", db);
            var home = await Call<ConnectionInfo>("connections.connect", live("") with { Authentication = "sql", Username = login, Password = scratch.Password });
            var homeOffline = false;
            try
            {
                var listed = await Listing(home.Id, "databases");
                var held = (await Sql(Ours(""))).Scalar;
                await actions.FreeDatabaseAsync(home.Id, db, CancellationToken.None);
                var settling = System.Diagnostics.Stopwatch.StartNew();
                string? left;
                while ((left = (await Sql(Ours(""))).Scalar) != "0" && settling.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(50);
                var taking = await Sql("ALTER DATABASE " + Bracket(db) + " SET OFFLINE WITH NO_WAIT;");
                homeOffline = taking.Status == "completed";
                var after = homeOffline ? await Listing(home.Id, "databases") : [];
                check(home.Database == db && listed.Any(node => node.Label == db) && held is not (null or "0") && left == "0" && homeOffline && after.Any(node => node.Label == db),
                    "a connection made with Database <default> is in the login's default database: freeing it moves its server-scope pools to master and ends its pooled sessions there, so SET OFFLINE needs no wait ("
                    + home.Database + ", " + held + " then " + left + ", " + taking.Error + ")");
            }
            finally
            {
                if (homeOffline) await Sql("ALTER DATABASE " + Bracket(db) + " SET ONLINE;");
                await Call<object>("connections.disconnect", new ConnectionArgs(home.Id));
                await Sql("ALTER LOGIN " + Bracket(login) + " WITH DEFAULT_DATABASE = [master];");
            }
        }
        else Console.WriteLine("Login template checks skipped: the server accepts Windows logins only.");

        // Critic A5: a connection opened in the database keeps an idle Object Explorer session there, which blocks taking it offline.
        var inside = await Call<ConnectionInfo>("connections.connect", live(db));
        var offline = false;
        try
        {
            var before = await Listing(inside.Id, "databases");
            var explorerInside = (await Sql(Ours(" - Object Explorer"))).Scalar;
            var refused = await Sql("ALTER DATABASE " + Bracket(db) + " SET OFFLINE WITH NO_WAIT;");
            await using (var monitor = ((IActivityHost)service).MonitorConnection(inside.Id))
            {
                await ((IActivityHost)service).OpenAsync(monitor, CancellationToken.None);
                await using var command = new SqlCommand("SELECT DB_NAME();", monitor);
                var monitorDatabase = (string?)await command.ExecuteScalarAsync();
                check(inside.Database == db && before.Any(node => node.Label == db) && explorerInside is not (null or "0") && refused.Status != "completed" && monitorDatabase == "master",
                    "before the move, Object Explorer's idle session sits in the connection's own database and SET OFFLINE WITH NO_WAIT is refused; Activity Monitor's pool is in master ("
                    + explorerInside + ", " + monitorDatabase + ")");
            }
            // Freed through another connection to the server (the one the action runs on), whose action waits for every pooled
            // session of this backend there, the connect's own plain one included.
            await actions.FreeDatabaseAsync(info.Id, db, CancellationToken.None);
            var left = (await Sql(Ours(""))).Scalar;
            var taking = await Sql("ALTER DATABASE " + Bracket(db) + " SET OFFLINE WITH NO_WAIT;");
            offline = taking.Status == "completed";
            var after = offline ? await Listing(inside.Id, "databases") : [];
            check(left == "0" && offline && after.Any(node => node.Label == db),
                "an action on one connection frees the database of every connection of this backend to the server: their server-scope pools move to master, it waits until no pooled session of this process stays in it, SET OFFLINE needs no wait, and Object Explorer still lists databases while it is offline ("
                + left + ", " + taking.Error + ")");
        }
        finally
        {
            if (offline) await Sql("ALTER DATABASE " + Bracket(db) + " SET ONLINE;");
            await Call<object>("connections.disconnect", new ConnectionArgs(inside.Id));
        }
    }
}
