using System.Globalization;
using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of Tasks › Detach… (PR D3b). Without scratch databases: SQL Server's own databases are refused before any
/// connection reads them. With VARIA_TEST_SQL_SCRATCH=1, in a marked VariaScratch_…_det database (and its snapshot _dets): the
/// describe reads the database's identity, sessions and files; a snapshot is a blocking warning the execute refuses, and when a plan
/// runs sp_detach_db anyway, SQL Server's failure after SINGLE_USER has Varia restore multi-user access (runner v2); a session in the
/// database makes sp_detach_db fail IN_USE without Drop Connections, and Drop Connections rolls it back; Stop just before
/// sp_detach_db restores the access the database had (MULTI_USER or RESTRICTED_USER); Script runs nothing and writes @skipchecks
/// 'true' when Update Statistics is cleared; a database replaced since the dialog read it is refused; an offline database on Windows
/// waits for Detach while offline (critic A27), one in EMERGENCY for Detach anyway, and neither is detached here (a guard fails any
/// step); Update Statistics is refused where sp_updatestats cannot run, and a read-only database that sp_detach_db detaches despite
/// 15635 is reported detached; a detach leaves the files the reply lists, which attach again; and a login that is neither sysadmin
/// nor in db_owner (no permission, ALTER on the database, ALTER ANY DATABASE) is refused before SINGLE_USER, while a db_owner member
/// and the owner see the files through sys.database_files. Every detached database is attached again and dropped, so its files
/// go with it. The hostile-name dry runs of the template are ActionLiveChecks' loop.</summary>
internal static class DetachLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
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
        Task<ActionDescribeResult> Describe(string name, string? connectionId = null) =>
            Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(connectionId ?? info.Id, Guid.NewGuid().ToString(), "detachDatabase", Database(name)));
        ActionArgs Detach(string name, bool drop, bool statistics, bool? offline = null, DatabaseIdentityDto? identity = null, string? connectionId = null) =>
            new("detach", connectionId ?? info.Id, Guid.NewGuid().ToString(), Database(name), Identity: identity, DropConnections: drop, UpdateStatistics: statistics, DetachOffline: offline);
        Task<ActionExecuteResult> Execute(ActionArgs args, RequestContext? context = null) => Call<ActionExecuteResult>("actions.execute", args, context);

        var refusals = new[] { await Refused(() => Describe("master")), await Refused(() => Execute(Detach("msdb", drop: true, statistics: false))), await Refused(() => Execute(Detach("tempdb", false, true))) };
        check(refusals.All(code => code == "INVALID_PARAMS"), "Detach refuses SQL Server's own databases before any connection: " + string.Join(", ", refusals));

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Detach Database scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating, detaching, attaching and dropping a uniquely named database on a disposable development server.");
            return;
        }
        var major = int.Parse(info.ProductVersion?.Split('.')[0] ?? "13", CultureInfo.InvariantCulture);
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var db = await scratch.CreateDetachedAsync();
        await Sql("CREATE TABLE dbo.Held (id int); INSERT dbo.Held VALUES (1);", db);
        async Task<string?> State() => (await Sql("SELECT state_desc + N' ' + user_access_desc FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar;
        async Task<DatabaseIdentityDto> Identity()
        {
            var row = (await Sql("SELECT database_id, FORMAT(create_date, 'yyyy-MM-ddTHH:mm:ss.fff', 'en-US') FROM sys.databases WHERE name = " + Literal(db) + ";")).Sets[0][0];
            return new(int.Parse(row[0]!, CultureInfo.InvariantCulture), row[1]!);
        }
        async Task<List<string>> Paths() => [.. (await Sql("SELECT physical_name FROM sys.master_files WHERE database_id = DB_ID(" + Literal(db) + ") ORDER BY file_id;")).Sets[0].Select(row => row[0]!)];
        var identity = await Identity();
        var paths = await Paths();

        // The describe: identity, no sessions, the files that stay (rows and log), nothing blocking, nothing to confirm.
        var quiet = await Describe(db);
        check(quiet is { Error: null, DatabaseState: { State: 0, UserAccess: 0, Sessions: 0, WithTransaction: 0, FilesTruncated: false, ConfirmOffline: null } state } && state.Identity == identity
            && state.Warnings.Count == 0 && state.Files is { Count: 2 } files && files.Select(file => file.Path).SequenceEqual(paths) && files[0] is { FileId: 1, Type: "rows" } && files[1] is { FileId: 2, Type: "log" },
            "Detach Database reads the database's identity, its sessions and the files that stay on the server (" + quiet.Error?.Message + ")");

        // A database snapshot: a blocking warning, refused at execute; a plan that runs sp_detach_db anyway fails in SQL Server after
        // SINGLE_USER, and the compensation restores multi-user access.
        if (await scratch.CreateDetachedSnapshotAsync())
        {
            var described = await Describe(db);
            var refused = await Execute(Detach(db, drop: true, statistics: false, identity: identity));
            var forced = await service.Actions.ExecutePlanAsync(info.Id, Guid.NewGuid().ToString(), "detach", ActionService.Plan(Detach(db, true, false), Database(db), new ActionService.DeleteFacts(false, 0)), CancellationToken.None);
            check(described.DatabaseState?.Warnings is [{ Blocking: true }] && refused is { Error.Code: "NOT_SUPPORTED" } && refused.Steps.Count == 0
                && forced.Error?.Code == "DEPENDENTS" && Steps(forced) == "done:Close existing connections, failed:Detach the database, done:Restore multi-user access"
                && forced.Steps[^1].Compensates == true && await State() == "ONLINE MULTI_USER",
                "a database snapshot blocks Detach; when sp_detach_db fails after SINGLE_USER (3709), Varia restores multi-user access (" + forced.Error?.Code + ": " + forced.Error?.Message + ", " + Steps(forced) + ")");
            await Sql("DROP DATABASE " + Bracket(scratch.DetachedSnapshot) + ";");
        }
        else Console.WriteLine("Detach snapshot checks skipped: this server could not create a snapshot.");

        // Update Statistics maps onto @skipchecks: cleared skips UPDATE STATISTICS ('true'), checked runs it ('false').
        var skip = await service.Actions.DryRunAsync(info.Id, ActionService.Plan(Detach(db, false, false), Database(db)).Single(), CancellationToken.None);
        var run = await service.Actions.DryRunAsync(info.Id, ActionService.Plan(Detach(db, false, true), Database(db)).Single(), CancellationToken.None);
        check(skip.SequenceEqual([db, "true"]) && run.SequenceEqual([db, "false"]), "sp_detach_db gets @skipchecks 'true' with Update Statistics cleared and 'false' with it checked");

        // Script Action: SSMS's statements, @skipchecks 'true' with its comment, and nothing runs.
        var script = await Call<ActionScriptResult>("actions.script", Detach(db, true, false));
        string Use(string statement) => "USE [master]" + Environment.NewLine + "GO" + Environment.NewLine + statement + Environment.NewLine + "GO" + Environment.NewLine;
        check(script is { Error: null, Database: "master" } && script.Text == ActionService.DetachSkipChecksComment + Use("ALTER DATABASE " + Bracket(db) + " SET  SINGLE_USER WITH ROLLBACK IMMEDIATE")
                + Use("EXEC master.dbo.sp_detach_db @dbname = " + Literal(db) + ", @skipchecks = 'true'") && await State() == "ONLINE MULTI_USER",
            "Script Action returns SSMS's SINGLE_USER and sp_detach_db with @skipchecks 'true', and runs nothing");

        // A database other than the one the dialog read is refused.
        var replaced = await Execute(Detach(db, false, false, identity: identity with { Id = identity.Id + 100_000 }));
        check(replaced is { Error.Code: "NOT_FOUND" } && replaced.Steps.Count == 0 && await State() == "ONLINE MULTI_USER", "Detach refuses a database that is not the one its dialog read, and changes nothing");

        // Stop just before sp_detach_db, after SINGLE_USER: the database gets back the access it had, MULTI_USER or RESTRICTED_USER.
        foreach (var (access, restore) in new[] { ("MULTI_USER", "Restore multi-user access"), ("RESTRICTED_USER", "Restore restricted user access") })
        {
            await Sql("ALTER DATABASE " + Bracket(db) + " SET " + access + " WITH ROLLBACK IMMEDIATE;");
            ActionExecuteResult? stopped = null;
            using (var context = new RequestContext(1, "actions.execute", RequestLane.Actions, 0))
            {
                service.Actions.Options.BeforeStep = (title, token) => { if (title == "Detach the database") context.Cancel(CancelReason.User); return Task.CompletedTask; };
                try { stopped = await Execute(Detach(db, drop: true, statistics: false, identity: identity), context); }
                catch (OperationCanceledException) { }
                finally { service.Actions.Options.BeforeStep = null; }
            }
            check(stopped is { Error.Code: "CANCELLED" } && Steps(stopped) == "done:Close existing connections, cancelled:Detach the database, done:" + restore && await State() == "ONLINE " + access,
                "Stop after SINGLE_USER and before sp_detach_db restores " + access + " (" + (stopped is null ? "unknown outcome" : Steps(stopped) + ", " + stopped.Error?.Message) + ")");
        }
        await Sql("ALTER DATABASE " + Bracket(db) + " SET MULTI_USER WITH ROLLBACK IMMEDIATE;");

        // An offline database on Windows waits for Detach while offline (critic A27); on Linux the describe only says so. It is never
        // detached offline here: SQL Server may leave its files where the next attach cannot open them.
        // A guard for checks that must be refused: no step may run. A refusal that let one through would detach the database, and on
        // Windows its files would then open to no attach this run can make (probed for EMERGENCY, and for a SQL login's detach).
        Func<string, CancellationToken, Task> neverDetach = (_, _) => throw new InvalidOperationException("A Detach check that must be refused reached a step.");
        var offline = false;
        service.Actions.Options.BeforeStep = neverDetach;
        try
        {
            await Sql("ALTER DATABASE " + Bracket(db) + " SET OFFLINE WITH ROLLBACK IMMEDIATE;");
            offline = true;
            var described = await Describe(db);
            if (info.Linux == true)
                check(described is { Error: null, DatabaseState: { State: 6, ConfirmOffline: null } } && described.DatabaseState.Warnings.Any(warning => !warning.Blocking && warning.Text == ActionService.DetachOfflineNote),
                    "on Linux, an offline database's Detach describe notes the risk without asking for Detach while offline");
            else
            {
                var refused = await Execute(Detach(db, false, false, identity: identity));
                check(described is { Error: null, DatabaseState: { State: 6, ConfirmOffline: true, Files.Count: 2 } } && refused is { Error.Code: "NOT_SUPPORTED" } && refused.Steps.Count == 0
                    && refused.Error.Message.Contains("Detach while offline", StringComparison.Ordinal) && await State() == "OFFLINE MULTI_USER",
                    "on Windows, Detach of an offline database waits for Detach while offline and changes nothing without it (" + described.Error?.Message + " | " + refused.Error?.Message + ")");
            }
        }
        finally { service.Actions.Options.BeforeStep = null; if (offline) await Sql("ALTER DATABASE " + Bracket(db) + " SET ONLINE;"); }

        // EMERGENCY, as the menu's suspect reason advises: on Windows its files end up as an offline detach leaves them (probed), so it
        // waits for Detach anyway; Update Statistics is refused everywhere (sp_updatestats raises 15635 and SQL Server detaches anyway).
        // It is never detached here.
        var emergency = false;
        service.Actions.Options.BeforeStep = neverDetach;
        try
        {
            emergency = (await Sql("ALTER DATABASE " + Bracket(db) + " SET EMERGENCY;")).Status == "completed";
            var described = await Describe(db);
            var statistics = await Execute(Detach(db, false, true, offline: true, identity: identity));
            var plainRefused = info.Linux == true ? null : await Execute(Detach(db, false, false, identity: identity));
            var noteOk = info.Linux == true
                ? described is { Error: null, DatabaseState: { State: 5, ConfirmOffline: null } } && described.DatabaseState.Warnings.Any(warning => !warning.Blocking && warning.Text.StartsWith("This database is in EMERGENCY mode.", StringComparison.Ordinal))
                : described is { Error: null, DatabaseState: { State: 5, ConfirmOffline: true, Files.Count: 2 } } && plainRefused is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 }
                    && plainRefused.Error.Message.Contains("Detach anyway", StringComparison.Ordinal);
            check(emergency && noteOk && statistics is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && statistics.Error.Message.StartsWith("Update Statistics cannot run", StringComparison.Ordinal)
                && await State() == "EMERGENCY MULTI_USER",
                "a database in EMERGENCY waits for Detach anyway on Windows (a note on Linux), refuses Update Statistics, and changes nothing (" + described.Error?.Message + " | "
                + statistics.Error?.Message + " | " + plainRefused?.Error?.Message + ")");
        }
        finally { service.Actions.Options.BeforeStep = null; if (emergency) await Sql("ALTER DATABASE " + Bracket(db) + " SET ONLINE;"); }

        // A session in the database: without Drop Connections sp_detach_db fails at once (3703) and the session keeps its transaction;
        // with it, the session is rolled back and the database detached, leaving its files, which attach again.
        var holder = Guid.NewGuid().ToString();
        try
        {
            var held = await Sql("BEGIN TRANSACTION; INSERT dbo.Held VALUES (2); SELECT @@SPID;", db, holder);
            var busy = await Describe(db);
            var inUse = await Execute(Detach(db, drop: false, statistics: false, identity: identity));
            var open = (await Sql("SELECT @@TRANCOUNT;", db, holder)).Scalar;
            var stateAfter = await State();
            check(held.Status == "completed" && busy is { Error: null, DatabaseState: { Sessions: 1, WithTransaction: 1 } } && inUse is { Error.Code: "IN_USE" } && Steps(inUse) == "failed:Detach the database"
                && inUse.Error.Message.EndsWith(ActionErrors.DropConnectionsAdvice, StringComparison.Ordinal) && open == "1" && stateAfter == "ONLINE MULTI_USER",
                "a session in the database makes sp_detach_db fail IN_USE without Drop Connections, and its transaction stays open (" + inUse.Error?.Message + "; held " + held.Status
                + ", described " + (busy.Error?.Code ?? busy.DatabaseState?.Sessions + " sessions, " + busy.DatabaseState?.WithTransaction + " with a transaction") + ", steps " + Steps(inUse)
                + ", @@TRANCOUNT " + open + ", " + stateAfter + ")");
            scratch.Detaching(db, paths);
            var detached = await Execute(Detach(db, drop: true, statistics: true, identity: identity));
            var after = await Sql("SELECT 1;", db, holder);
            var gone = (await Sql("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar;
            var exist = major < 14 ? "skipped" : string.Join(",", await Task.WhenAll(paths.Select(async path => (await Sql("SELECT CONVERT(int, file_exists) FROM sys.dm_os_file_exists(" + Literal(path) + ");")).Scalar)));
            check(detached.Error is null && Steps(detached) == "done:Close existing connections, done:Detach the database" && after.Status != "completed" && gone == "0"
                && detached.FilesKept?.Select(file => file.Path).SequenceEqual(paths) == true && (exist == "skipped" || exist == "1,1"),
                "Drop Connections rolls the session back, the database is detached with Update Statistics, and the reply lists its files, which stay on the server (" + detached.Error?.Message + ", " + exist + ")");
        }
        finally { await Call<object>("query.session.close", new SessionArgs(holder)); }
        var attached = await Sql(ScratchDatabase.AttachSql(db, paths));
        if (attached.Status == "completed") scratch.Attached(db);
        check(attached.Status == "completed" && await State() == "ONLINE MULTI_USER" && (await Sql("SELECT COUNT(*) FROM dbo.Held;", db)).Scalar == "1",
            "the files a detach leaves attach again, multi-user, without the rolled-back row (" + attached.Error + ")");

        // No session, Update Statistics cleared: sp_detach_db alone, with @skipchecks 'true'.
        identity = await Identity();
        scratch.Detaching(db, paths);
        var plain = await Execute(Detach(db, drop: false, statistics: false, identity: identity));
        var plainGone = (await Sql("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar;
        var reattached = await Sql(ScratchDatabase.AttachSql(db, paths));
        if (reattached.Status == "completed") scratch.Attached(db);
        check(plain.Error is null && Steps(plain) == "done:Detach the database" && plain.FilesKept?.Count == 2 && plainGone == "0" && reattached.Status == "completed" && await State() == "ONLINE MULTI_USER",
            "with no session, Detach runs sp_detach_db alone and the database attaches again (" + plain.Error?.Message + ")");

        // Update Statistics on a read-only database: the execute refuses it, cleared it would run. Run anyway (the plan seam), sp_detach_db's
        // sp_updatestats raises 15635, which aborts nothing, and SQL Server detaches the database all the same: the reply must say so (the
        // step done, 15635 kept as a message, no compensation on a database that is gone), or, where a server keeps it, the failure with
        // the access restored.
        await Sql("ALTER DATABASE " + Bracket(db) + " SET READ_ONLY WITH ROLLBACK IMMEDIATE;");
        identity = await Identity();
        var readOnlyRefused = await Execute(Detach(db, drop: true, statistics: true, identity: identity));
        scratch.Detaching(db, paths);
        var readOnly = await service.Actions.ExecutePlanAsync(info.Id, Guid.NewGuid().ToString(), "detach", ActionService.Plan(Detach(db, true, true), Database(db), new ActionService.DeleteFacts(false, 0)), CancellationToken.None);
        var readOnlyGone = (await Sql("SELECT COUNT(*) FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar == "0";
        if (readOnlyGone)
        {
            var back = await Sql(ScratchDatabase.AttachSql(db, paths));
            if (back.Status == "completed") scratch.Attached(db);
        }
        else scratch.Attached(db);
        await Sql("ALTER DATABASE " + Bracket(db) + " SET READ_WRITE WITH ROLLBACK IMMEDIATE;");
        check(readOnlyRefused is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && readOnlyRefused.Error.Message.StartsWith("Update Statistics cannot run on a read-only", StringComparison.Ordinal)
            && (readOnlyGone
                ? readOnly.Error is null && Steps(readOnly) == "done:Close existing connections, done:Detach the database" && readOnly.Messages.Any(message => message.Contains("sp_updatestats", StringComparison.Ordinal))
                : readOnly.Error is not null && Steps(readOnly) == "done:Close existing connections, failed:Detach the database, done:Restore multi-user access")
            && await State() == "ONLINE MULTI_USER",
            "Detach refuses Update Statistics on a read-only database, and when sp_detach_db detaches it despite 15635 the reply says it was detached (" + (readOnlyGone ? "detached" : "kept") + ": "
            + Steps(readOnly) + ", " + readOnly.Error?.Message + ", " + string.Join(" / ", readOnly.Messages) + ")");

        // Permission: DBCC DETACHDB needs db_owner or sysadmin. ALTER on the database and ALTER ANY DATABASE pass SET OFFLINE's check but
        // not DETACHDB's (7983), so they are refused before SINGLE_USER rolls back anyone's work; db_owner and ownership may detach, and
        // see the files through sys.database_files without VIEW ANY DEFINITION. The SQL login never detaches here: on Windows only a
        // SQL-authenticated attach could open its files again.
        if (await scratch.CreateLoginAsync())
        {
            var login = Bracket(scratch.Login!);
            var low = await Call<ConnectionInfo>("connections.connect", live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password });
            identity = await Identity();
            var holder2 = Guid.NewGuid().ToString();
            var owner = (await Sql("SELECT SUSER_SNAME(owner_sid) FROM sys.databases WHERE name = " + Literal(db) + ";")).Scalar!;
            service.Actions.Options.BeforeStep = neverDetach;
            try
            {
                var described = await Describe(db, low.Id);
                var executed = await Execute(Detach(db, drop: true, statistics: false, connectionId: low.Id));
                check(executed is { Error.Code: "PERMISSION_DENIED" } && executed.Steps.Count == 0 && described.Error?.Code == "PERMISSION_DENIED" && await State() == "ONLINE MULTI_USER",
                    "a login with no permission on the database cannot detach it (" + described.Error?.Code + ", " + executed.Error?.Message + ")");

                await Sql("BEGIN TRANSACTION; INSERT dbo.Held VALUES (3);", db, holder2);
                await Sql("CREATE USER " + login + " FOR LOGIN " + login + "; GRANT ALTER TO " + login + ";", db);
                foreach (var anyDatabase in new[] { false, true })
                {
                    if (anyDatabase) { await Sql("REVOKE ALTER FROM " + login + ";", db); await Sql("GRANT ALTER ANY DATABASE TO " + login + ";"); }
                    try
                    {
                        var deniedDescribe = await Describe(db, low.Id);
                        var denied = await Execute(Detach(db, drop: true, statistics: false, identity: identity, connectionId: low.Id));
                        var open = (await Sql("SELECT @@TRANCOUNT;", db, holder2)).Scalar;
                        check(deniedDescribe.Error?.Code == "PERMISSION_DENIED" && denied is { Error.Code: "PERMISSION_DENIED", Steps.Count: 0 } && open == "1" && await State() == "ONLINE MULTI_USER",
                            "a login with " + (anyDatabase ? "ALTER ANY DATABASE" : "ALTER on the database") + " but not db_owner is refused Detach before SINGLE_USER, and another session's transaction stays open ("
                            + deniedDescribe.Error?.Message + " | " + denied.Error?.Message + ")");
                    }
                    finally { if (anyDatabase) await Sql("REVOKE ALTER ANY DATABASE FROM " + login + ";"); }
                }
                await Sql("ALTER ROLE [db_owner] ADD MEMBER " + login + ";", db);
                var member = await Describe(db, low.Id);
                check(member is { Error: null, DatabaseState.Files: { } memberFiles } && memberFiles.Select(file => file.Path).SequenceEqual(paths)
                    && (info.Linux == true) != member.DatabaseState.Warnings.Any(warning => !warning.Blocking && warning.Text == ActionService.DetachSqlLoginNote),
                    "a db_owner member without VIEW ANY DEFINITION may detach, sees the files that stay (sys.database_files), and on Windows is told a SQL login's files need SQL authentication (" + member.Error?.Message + ")");
                await Sql("ALTER ROLE [db_owner] DROP MEMBER " + login + "; DROP USER " + login + ";", db);
                await Sql("ALTER AUTHORIZATION ON DATABASE::" + Bracket(db) + " TO " + login + ";");
                var owned = await Describe(db, low.Id);
                check(owned is { Error: null, DatabaseState.Files: { } ownedFiles } && ownedFiles.Select(file => file.Path).SequenceEqual(paths),
                    "the database's owner may detach it and sees the files that stay (" + owned.Error?.Message + ")");
            }
            finally
            {
                service.Actions.Options.BeforeStep = null;
                await Call<object>("query.session.close", new SessionArgs(holder2));
                await Sql("ALTER AUTHORIZATION ON DATABASE::" + Bracket(db) + " TO " + Bracket(owner) + ";");
                await Call<object>("connections.disconnect", new ConnectionArgs(low.Id));
            }
        }
        else Console.WriteLine("Detach permission checks skipped: the server accepts Windows logins only.");
    }
}
