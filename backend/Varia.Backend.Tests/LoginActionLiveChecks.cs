using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of a login's Disable, Enable and Rename (PR D4b). Without scratch objects: the service lookup's SQL runs,
/// a login a SQL Server service runs as is described with that service, SQL Server's own logins are refused, and the login
/// this connection uses is refused by the preflight alone (it is never changed). With VARIA_TEST_SQL_SCRATCH=1, on the run's
/// own scratch SQL logins only: Disable keeps an open session while a new sign-in fails (18470), Enable lets it in again,
/// Script runs nothing, rename to a hostile name and back, a taken name, a backslash and a ##…## name, a ##…## login asked for
/// by other spellings, its facts and Stop while another session holds the login, and, connected as the scratch login, its own
/// login and a login it may not alter. The scratch logins are dropped in
/// finally, under any name a check gave them.</summary>
internal static class LoginActionLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        async Task<T> Call<T>(string method, object args, RequestContext? context = null) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json, context);
        async Task<SqlRun> InSession(string connectionId, string session, string text)
        {
            var result = await Call<QueryResult>("query.execute", new QueryArgs(connectionId, session, "master", text, Guid.NewGuid().ToString(), 100_000, 60, StopOnError: true));
            return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
        }
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var session = Guid.NewGuid().ToString();
            try { return await InSession(info.Id, session, database == "master" ? text : "USE " + Bracket(database) + ";\n" + text); }
            finally { await Call<object>("query.session.close", new SessionArgs(session)); }
        }
        ObjectRefDto Login(string name) => new("login", Name: name);
        Task<ActionDescribeResult> Describe(string connectionId, string name) =>
            Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(connectionId, Guid.NewGuid().ToString(), "loginFacts", Login(name)));
        Task<ActionExecuteResult> Execute(string connectionId, string action, string name, string? newName = null, RequestContext? context = null) =>
            Call<ActionExecuteResult>("actions.execute", new ActionArgs(action, connectionId, Guid.NewGuid().ToString(), Login(name), newName), context);
        async Task<string> Refused(Func<Task<ActionExecuteResult>> call)
        {
            try { return await call() is { Error: { } error } result ? error.Code + (result.Steps.Count == 0 ? "" : " after steps") : "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title));
        var words = service.Actions.Catalog.Logins;

        // The service lookup's constant text runs on this server (a read of sys.dm_server_services needs VIEW SERVER STATE,
        // which the checks' login has); the backend would answer a failed read with no service rather than say why.
        var lookup = await Sql("DECLARE @take int = 8, @name nvarchar(128) = N'NT AUTHORITY\\SYSTEM';\n" + ActionSql.LoginService);
        check(lookup.Status == "completed" && lookup.Sets.Count == 1, "the login service lookup's SQL runs: " + lookup.Status + " " + lookup.Error);

        // A Windows login a service runs as (NT SERVICE\MSSQLSERVER on a default Windows install): the describe names its service.
        // Reading it changes nothing. Linux servers run as no Windows login, so there the check is skipped.
        var serviceLogin = await Sql("SELECT TOP (1) p.name, s.servicename FROM sys.server_principals AS p JOIN sys.dm_server_services AS s ON UPPER(s.service_account) = UPPER(p.name) "
            + "WHERE p.type = 'U' ORDER BY p.name;");
        if (serviceLogin.Sets is [[[{ } runAs, { } serviceName], ..]])
        {
            var described = await Describe(info.Id, runAs);
            check(described is { Error: null, Login: { Type: "U", Service: { } named } } && named.Contains(serviceName, StringComparison.Ordinal),
                "the loginFacts describe names the service a Windows login runs (" + described.Login?.Service + ")");
        }
        else Console.WriteLine("Login service check skipped: no SQL Server service runs as a Windows login on this server.");

        // SQL Server's own logins are refused before the preflight looks for them (this one does not exist, so nothing could change).
        var system = "##VariaScratch_system##";
        var systemRefusals = new[] { await Refused(() => Execute(info.Id, "disable", system)), await Refused(() => Execute(info.Id, "rename", system, system + "2")) };
        check(systemRefusals.SequenceEqual(["INVALID_PARAMS", "INVALID_PARAMS"]), "a login named ##…## is SQL Server's own and refused: " + string.Join(", ", systemRefusals));

        // The connection's own login: the preflight alone refuses it, so this check never sends DDL for it.
        var own = (await Sql("SELECT SUSER_SNAME();")).Scalar ?? "";
        if (await service.Actions.LoginFactsAsync(info.Id, own, CancellationToken.None) is { } ownFacts)
        {
            var refusal = service.Actions.LoginRefusal(ownFacts, new ActionArgs("disable", info.Id, Guid.NewGuid().ToString(), Login(own)));
            var renaming = service.Actions.LoginRefusal(ownFacts, new ActionArgs("rename", info.Id, Guid.NewGuid().ToString(), Login(own), own + "2"));
            check(ownFacts.Own && refusal is { Code: "NOT_SUPPORTED" } && refusal.Message == words.Message("own") && renaming is { Code: "NOT_SUPPORTED" },
                "the preflight finds the login this connection uses and refuses to disable or rename it");
        }
        else Console.WriteLine("Own-login check skipped: this connection gets in through a Windows group.");

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Login action scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping uniquely named logins on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        if (!await scratch.CreateLoginAsync())
        {
            Console.WriteLine("Login action scratch checks skipped: the server accepts Windows logins only.");
            return;
        }
        var login = scratch.Login!;
        var taken = login + "_lt";
        var hostile = login + "_lr]' --";
        var reserved = "##" + login + "_ls##";
        var unreserved = login + "_lsx";
        var connectivity = live("master");
        async Task<string> SignIn()
        {
            // Unpooled, so the attempt is a new sign-in rather than a reset of a pooled one.
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = connectivity.Server, InitialCatalog = "master", UserID = login, Password = scratch.Password, TrustServerCertificate = true, Pooling = false,
                ConnectTimeout = 30, ApplicationName = "Varia checks"
            };
            try
            {
                await using var connection = new SqlConnection(builder.ConnectionString);
                await connection.OpenAsync();
                return "signed in";
            }
            catch (SqlException error) { return "Msg " + error.Number; }
        }
        async Task<string?> Disabled(string name) => (await Sql("SELECT CONVERT(int, is_disabled) FROM sys.server_principals WHERE name = " + Literal(name) + ";")).Scalar;
        async Task<bool> Exists(string name) => (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name = " + Literal(name) + ";")).Scalar == "1";

        try
        {
            var takenPassword = "Vx9!" + Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(12));
            var created = await Sql("CREATE LOGIN " + Bracket(taken) + " WITH PASSWORD = " + Literal(takenPassword) + ", CHECK_POLICY = OFF;\nGRANT VIEW ANY DEFINITION TO " + Bracket(login) + ";");
            check(created.Status == "completed", "the login action checks create a second scratch login: " + created.Error);

            var plain = await Describe(info.Id, login);
            check(plain is { Error: null, Login: { Subtype: "sql", Type: "S", Disabled: false, Own: false, Service: null, CanAlter: true } },
                "the loginFacts describe answers a SQL login's facts, with no service");

            // Script Action writes the statement in master and runs nothing.
            var nl = Environment.NewLine;
            var script = await Call<ActionScriptResult>("actions.script", new ActionArgs("disable", info.Id, Guid.NewGuid().ToString(), Login(login)));
            check(script is { Error: null, Database: "master" } && script.Text == "USE [master]" + nl + "GO" + nl + "ALTER LOGIN " + Bracket(login) + " DISABLE" + nl + "GO" + nl
                && await Disabled(login) == "0", "Script Action writes ALTER LOGIN … DISABLE in master and runs nothing: " + script.Error?.Message);

            // Disable keeps a session the login already has, and refuses a new sign-in (18470); Enable lets it in again.
            var limited = await Call<ConnectionInfo>("connections.connect", live("master") with { Authentication = "sql", Username = login, Password = scratch.Password });
            var kept = Guid.NewGuid().ToString();
            try
            {
                var opened = await InSession(limited.Id, kept, "SELECT 1;");
                var counted = await Describe(info.Id, login);
                var disabled = await Execute(info.Id, "disable", login);
                var stillOpen = await InSession(limited.Id, kept, "SELECT SUSER_SNAME();");
                var refused = await SignIn();
                var state = await Disabled(login);
                var enabled = await Execute(info.Id, "enable", login);
                var admitted = await SignIn();
                check(opened.Status == "completed" && counted.Login?.Sessions >= 1 && Steps(disabled) == "done:Disable the login" && disabled is { Error: null, Sessions: >= 1 }
                    && state == "1" && stillOpen.Status == "completed" && stillOpen.Scalar == login && refused == "Msg 18470"
                    && Steps(enabled) == "done:Enable the login" && enabled.Error is null && await Disabled(login) == "0" && admitted == "signed in",
                    "Disable stops new sign-ins (" + refused + ") while the login's open session stays, its reply counts that session (" + disabled.Sessions + "), and Enable lets it in again ("
                    + admitted + ")");

                // Connected as the scratch login: its own login is refused, and another login it can see but not alter is PERMISSION_DENIED.
                var ownRefusal = await Execute(limited.Id, "disable", login);
                var denied = await Execute(limited.Id, "disable", taken);
                check(ownRefusal is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && ownRefusal.Error.Message == words.Message("own")
                    && denied is { Error.Code: "PERMISSION_DENIED", Steps.Count: 0 } && denied.Error.Message == words.Message("alterAnyLogin")
                    && await Disabled(login) == "0" && await Disabled(taken) == "0",
                    "connected as a login, Disable refuses that login and a login without ALTER ANY LOGIN, before any DDL: " + ownRefusal.Error?.Code + ", " + denied.Error?.Code);
            }
            finally
            {
                await Call<object>("query.session.close", new SessionArgs(kept));
                await Call<object>("connections.disconnect", new ConnectionArgs(limited.Id));
            }

            // Rename: to a hostile name and back, then a taken name and a backslash, refused before any DDL.
            var away = await Execute(info.Id, "rename", login, hostile);
            var awayExists = await Exists(hostile) && !await Exists(login);
            var back = await Execute(info.Id, "rename", hostile, login);
            var collision = await Execute(info.Id, "rename", login, taken);
            var backslash = await Execute(info.Id, "rename", login, login + "\\x");
            // SQL Server accepts a ##…## name, which would make Varia take the login for one of SQL Server's own.
            var reservedName = await Refused(() => Execute(info.Id, "rename", login, reserved));
            check(Steps(away) == "done:Rename" && away.Error is null && awayExists && Steps(back) == "done:Rename" && back.Error is null && await Exists(login)
                && collision is { Error.Code: "NAME_IN_USE", Steps.Count: 0 } && backslash is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && backslash.Error.Message == words.Message("sqlBackslash")
                && reservedName == "INVALID_PARAMS" && await Exists(taken) && !await Exists(login + "\\x") && !await Exists(reserved),
                "a login is renamed to a name with brackets, quotes and a comment and back; a taken name is NAME_IN_USE, a backslash NOT_SUPPORTED and a ##…## name refused, before any DDL: "
                + away.Error?.Message + back.Error?.Message + collision.Error?.Code + " " + backslash.Error?.Code + " " + reservedName);

            // A login in SQL Server's own name form, asked for by a spelling the server collation matches to it: with a trailing
            // space (names compare without one), and with fullwidth ＃ (where the collation ignores width). The preflight judges the
            // principal it found by the catalog's name, so neither spelling changes it.
            var reservedPassword = "Vx9!" + Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(12));
            var madeReserved = await Sql("CREATE LOGIN " + Bracket(reserved) + " WITH PASSWORD = " + Literal(reservedPassword) + ", CHECK_POLICY = OFF;");
            var fullwidth = reserved.Replace('#', '＃');
            var widthBlind = (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name = " + Literal(fullwidth) + ";")).Scalar == "1";
            var expected = widthBlind ? "NOT_SUPPORTED" : "NOT_FOUND";
            var spellings = new[]
            {
                await Refused(() => Execute(info.Id, "disable", reserved + " ")), await Refused(() => Execute(info.Id, "rename", reserved + " ", unreserved)),
                await Refused(() => Execute(info.Id, "disable", fullwidth)), await Refused(() => Execute(info.Id, "enable", fullwidth)), await Refused(() => Execute(info.Id, "rename", fullwidth, unreserved))
            };
            var spacedFacts = await service.Actions.LoginFactsAsync(info.Id, reserved + " ", CancellationToken.None);
            var wideFacts = await Describe(info.Id, fullwidth);
            check(madeReserved.Status == "completed" && spellings.SequenceEqual(["INVALID_PARAMS", "INVALID_PARAMS", expected, expected, expected]) && spacedFacts?.Subtype == "system"
                && (widthBlind ? wideFacts.Login?.Subtype == "system" : wideFacts.Error?.Code == "NOT_FOUND") && await Disabled(reserved) == "0" && !await Exists(unreserved),
                "a login named ##…## stays SQL Server's own under a trailing space and a fullwidth spelling (width-insensitive: " + widthBlind + "), before any DDL: "
                + madeReserved.Error + string.Join(", ", spellings));

            // Another session changes the login in an open transaction (D4 P8): a disabled login enabled, which locks its row. The
            // loginFacts describe still answers at once (it reads past the change rather than waiting out the read lock timeout,
            // which would answer BLOCKED), and Disable waits for the change without a timeout, before or in its step, until Stop.
            var holder = Guid.NewGuid().ToString();
            try
            {
                var off = await Sql("ALTER LOGIN " + Bracket(login) + " DISABLE;");
                var held = await InSession(info.Id, holder, "BEGIN TRANSACTION;\nALTER LOGIN " + Bracket(login) + " ENABLE;");
                var reading = Stopwatch.StartNew();
                var facts = await Describe(info.Id, login);
                var readMs = reading.ElapsedMilliseconds;
                using var context = new RequestContext(1, "actions.execute", RequestLane.Actions, 0);
                var waiting = Execute(info.Id, "disable", login, context: context);
                var stillWaiting = !await Task.WhenAny(waiting, Task.Delay(2000)).ContinueWith(done => done.Result == waiting);
                var watch = Stopwatch.StartNew();
                context.Cancel(CancelReason.User);
                ActionExecuteResult? stopped = null;
                try { stopped = await waiting; } catch (OperationCanceledException) { }
                var answeredMs = watch.ElapsedMilliseconds;
                await InSession(info.Id, holder, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;");
                check(off.Status == "completed" && held.Status == "completed" && facts is { Error: null, Login.Subtype: "sql" } && stillWaiting && stopped is { Error.Code: "CANCELLED" }
                    && Steps(stopped) is "" or "cancelled:Disable the login" && answeredMs < 5000 && await Disabled(login) == "1",
                    "behind another session's change to the login, its facts answer (" + readMs + " ms, " + facts.Error?.Code + ") and Disable waits until Stop, which answers once SQL Server "
                    + "cancelled it (" + answeredMs + " ms, " + stopped?.Error?.Message + ")");
            }
            finally
            {
                await InSession(info.Id, holder, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;");
                await Call<object>("query.session.close", new SessionArgs(holder));
                await Sql("ALTER LOGIN " + Bracket(login) + " ENABLE;");
            }
        }
        finally
        {
            // The scratch logins under any name a check left them with; the scratch login itself goes with the scratch name.
            await Sql("IF SUSER_ID(" + Literal(hostile) + ") IS NOT NULL AND SUSER_ID(" + Literal(login) + ") IS NULL ALTER LOGIN " + Bracket(hostile) + " WITH NAME = " + Bracket(login) + ";\n"
                + "IF SUSER_ID(" + Literal(taken) + ") IS NOT NULL DROP LOGIN " + Bracket(taken) + ";\n"
                + "IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = " + Literal(reserved) + " AND type = 'S') DROP LOGIN " + Bracket(reserved) + ";\n"
                + "IF SUSER_ID(" + Literal(unreserved) + ") IS NOT NULL DROP LOGIN " + Bracket(unreserved) + ";");
        }
    }
}
