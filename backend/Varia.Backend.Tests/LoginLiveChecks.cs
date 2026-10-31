using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR D2a, New Login. Without scratch objects: the CREATE LOGIN SQL Server builds from the batch, for hostile
/// names and passwords in every shape, is the statement LoginSql writes, and a NULL password creates nothing. With
/// VARIA_TEST_SQL_SCRATCH=1, on SQL logins named VariaScratch_…_l…: New Login's describe; a real create through ActionService
/// (PWDCOMPARE, options, language, Deny, Disabled, a server role); a role that does not exist failing after the login was created,
/// which stays and is said to; Stop before a role; errors as values (a name in use, a missing database and language, a Windows
/// account, the password policy), none holding the password; no cached plan holding it; and critic A24's check that a held New Login
/// does not keep another SQL login from signing in. With VARIA_TEST_SQL_XE=1 too (CI's disposable container only, decision 14): an
/// Extended Events session records RPCs and batches while New Login and Create Catalog's master key run, and must not hold either
/// password (critic A16). Passwords are throwaway and never printed.</summary>
internal static class LoginLiveChecks
{
    private static readonly ObjectRefDto Server = new("server");

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json, bool required = false)
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
        var actions = service.Actions;
        var host = (IActionHost)service;
        // ExplorerCatalog's ServerEngine: Azure SQL Database (5), Synapse (6, 11) and Edge (9) are cloud, Managed Instance (8) its own.
        var edition = (await Sql("SELECT CONVERT(int, SERVERPROPERTY('EngineEdition'));")).Scalar;
        if (!actions.Catalog.Serves("createLogin", edition is "5" or "6" or "9" or "11" ? "cloud" : edition == "8" ? "managedInstance" : "box"))
        {
            if (required) throw new Exception("--logins-live needs a SQL Server New Login serves (a box edition).");
            Console.WriteLine("New Login live checks skipped: the server is not one New Login serves yet.");
            return;
        }

        await DryRunsAsync(check, actions, info);

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("New Login scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping uniquely named logins on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var facts = (await Sql("SELECT CONVERT(int, SERVERPROPERTY('IsIntegratedSecurityOnly')), IS_SRVROLEMEMBER(N'sysadmin');")).Sets[0][0];
        var windowsOnly = facts[0] == "1";
        if (facts[1] != "1")
        {
            if (required) throw new Exception("--logins-live needs a sysadmin connection.");
            Console.WriteLine("New Login scratch checks skipped: they need a sysadmin connection.");
            return;
        }

        async Task<T> With<T>(Func<SqlConnection, Task<T>> body)
        {
            await using var connection = host.Connection(info.Id);
            await host.OpenAsync(connection, CancellationToken.None);
            return await body(connection);
        }
        ActionArgs Create(NewLoginDto login, string? password, List<string>? roles = null, LoginStatusDto? status = null) =>
            LoginChecks.Create(login, password, roles, status) with { ConnectionId = info.Id };
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title + (step.Detail is null ? "" : "/" + step.Detail)));
        static bool Holds(ActionExecuteResult result, string secret) => JsonSerializer.Serialize(result).Contains(secret, StringComparison.Ordinal)
            || JsonSerializer.Serialize(result).Contains(secret.Replace("'", "''", StringComparison.Ordinal), StringComparison.Ordinal);

        // New Login's describe: the lists and the server's facts.
        var described = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "newLogin", Server), CancellationToken.None);
        check(described.NewLogin is { } model && model.Databases.Any(database => database.Name == "master" && database.Accessible) && model.Languages.Any(language => language.Name == "us_english")
            && model.ServerRoles.Any(role => role is { Name: "sysadmin", Fixed: true }) && model.ServerRoles.Any(role => role.Name == "public") && model.Server.WindowsOnly == windowsOnly
            && model.Server.CanCreate && !model.ServerRolesTruncated,
            "New Login's describe lists the databases, languages and server roles, and says whether the server takes Windows authentication only");

        // A real create: a SQL Server login, policy off (so any OS policy takes it), Deny, Disabled, a language and a server role.
        var name = scratch.OwnLogin("new");
        var password = ScratchDatabase.Throwaway() + "'＇]";
        var created = await actions.ExecuteAsync(Create(LoginChecks.Sql(name, false, false, false, language: "us_english"), password, ["dbcreator"], new("deny", false)), CancellationToken.None);
        var row = await With(async connection =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT PWDCOMPARE(@pw, l.password_hash), l.is_policy_checked, l.is_expiration_checked, l.is_disabled, l.default_database_name, l.default_language_name, "
                + "IS_SRVROLEMEMBER(N'dbcreator', l.name), (SELECT p.state FROM sys.server_permissions AS p WHERE p.grantee_principal_id = l.principal_id AND p.type = 'COSQ') "
                + "FROM sys.sql_logins AS l WHERE l.name = @name;";
            command.Parameters.Add(new SqlParameter("@pw", System.Data.SqlDbType.NVarChar, 128) { Value = password });
            command.Parameters.Add(new SqlParameter("@name", System.Data.SqlDbType.NVarChar, 128) { Value = name });
            await using var reader = await command.ExecuteReaderAsync();
            return await reader.ReadAsync() ? Enumerable.Range(0, reader.FieldCount).Select(i => reader.IsDBNull(i) ? "" : Convert.ToString(reader.GetValue(i), System.Globalization.CultureInfo.InvariantCulture)).ToArray() : null;
        });
        check(created.Error is null && Steps(created) == "done:Create the login, done:Deny permission to connect, done:Disable the login, done:Add to a server role/dbcreator" && !Holds(created, password)
            && row is ["1", "False", "False", "True", "master", "us_english", "1", "D"],
            "New Login creates the SQL Server login with the password typed (quotes and U+FF07 included), its options and language, then denies connect, disables it and adds its role, in SSMS's order: "
            + Steps(created) + " | " + (row is null ? "no login" : string.Join(",", row.Skip(1))));

        // A plan cached for any of it would hold the password in its text.
        var cached = await With(async connection =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM sys.dm_exec_cached_plans AS p CROSS APPLY sys.dm_exec_sql_text(p.plan_handle) AS t WHERE CHARINDEX(@pw, t.text) > 0;";
            command.Parameters.Add(new SqlParameter("@pw", System.Data.SqlDbType.NVarChar, 128) { Value = password });
            return Convert.ToInt32(await command.ExecuteScalarAsync(), System.Globalization.CultureInfo.InvariantCulture);
        });
        check(cached == 0, "no cached plan's text holds New Login's password");

        // A server role that does not exist fails after the login was created: the login stays, and the reply says so.
        var partialName = scratch.OwnLogin("part");
        var partial = await actions.ExecuteAsync(Create(LoginChecks.Sql(partialName, false, false, false), password, ["dbcreator", "VariaNoSuchRole"]), CancellationToken.None);
        var partialExists = (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name = N'" + partialName + "';")).Scalar;
        check(partial.Error is { } partialError && partialError.Message.EndsWith(ActionService.LoginCreatedMessage, StringComparison.Ordinal) && partialExists == "1" && !Holds(partial, password)
            && Steps(partial) == "done:Create the login, done:Add to a server role/dbcreator, failed:Add to a server role/VariaNoSuchRole",
            "a role that does not exist fails after the login was created, which stays, and the reply lists the steps and says so: " + Steps(partial) + " | " + partial.Error?.Code);

        // Stop before a server role: SSMS's statements ran one by one, so the login stays, and the reply says so.
        var stopName = scratch.OwnLogin("stop");
        using (var stop = new CancellationTokenSource())
        {
            actions.Options.BeforeStep = (title, _) => { if (title == "Add to a server role") stop.Cancel(); return Task.CompletedTask; };
            try
            {
                ActionExecuteResult? stopped = null;
                try { stopped = await actions.ExecuteAsync(Create(LoginChecks.Sql(stopName, false, false, false), password, ["dbcreator"], new("deny", true)), stop.Token); }
                catch (OperationCanceledException) { }
                var stopExists = (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name = N'" + stopName + "';")).Scalar;
                check(stopped is { Error.Code: "CANCELLED" } && stopped.Error.Message.EndsWith(ActionService.LoginCreatedMessage, StringComparison.Ordinal) && stopExists == "1"
                    && stopped.Steps.Take(2).Select(step => step.Status).SequenceEqual(["done", "done"]) && stopped.Steps[^1].Status is "cancelled" or "skipped" && !Holds(stopped, password),
                    "Stop before a server role answers CANCELLED with what completed, and says the login was created: " + (stopped is null ? "an unknown outcome" : Steps(stopped)));
            }
            finally { actions.Options.BeforeStep = null; }
        }

        // Errors as values, none holding the password.
        async Task<ActionExecuteResult> Refused(NewLoginDto login, string? secret = null) => await actions.ExecuteAsync(Create(login, secret ?? password), CancellationToken.None);
        var inUse = await Refused(LoginChecks.Sql(name, false, false, false));
        var role = await Refused(LoginChecks.Sql("sysadmin", false, false, false));
        var noDatabase = await Refused(LoginChecks.Sql(scratch.OwnLogin("nodb"), false, false, false, database: scratch.Name + "_none"));
        var noLanguage = await Refused(LoginChecks.Sql(scratch.OwnLogin("nolang"), false, false, false, language: "VariaNoLanguage"));
        check(inUse is { Error.Code: "NAME_IN_USE", Steps.Count: 0 } && role is { Error.Code: "NAME_IN_USE", Steps.Count: 0 } && noDatabase.Error?.Code == "NOT_FOUND" && noLanguage.Error?.Code == "NOT_FOUND"
            && new[] { inUse, role, noDatabase, noLanguage }.All(result => !Holds(result, password)),
            "a name a login or server role has is NAME_IN_USE before anything runs, and a missing default database or language is NOT_FOUND, none holding the password: "
            + string.Join(", ", new[] { inUse, role, noDatabase, noLanguage }.Select(result => result.Error?.Code ?? "ok")));
        var windows = await actions.ExecuteAsync(Create(LoginChecks.Windows("VariaNoDomain\\VariaNoUser" + Guid.NewGuid().ToString("N")[..8]), null), CancellationToken.None);
        check(windows.Error is { Code: "NOT_FOUND" or "NOT_SUPPORTED" or "SQL_ERROR" } && windows.Steps is [{ Status: "failed" }],
            "a Windows account that does not exist fails as a value at its CREATE LOGIN: " + windows.Error?.Code + " " + windows.Error?.Message);
        var weakName = scratch.OwnLogin("weak");
        var weak = await actions.ExecuteAsync(Create(LoginChecks.Sql(weakName, true, false, false), "zq"), CancellationToken.None);
        check(weak.Error is null or { Code: "PASSWORD_POLICY" } && !Holds(weak, "zq"),
            "the server's password policy answers PASSWORD_POLICY (or takes the password where the OS policy is lax): " + (weak.Error?.Code ?? "created"));
        if (weak.Error is null) Console.WriteLine("New Login: this server's password policy took a two-character password (a lax OS policy); PASSWORD_POLICY was not exercised.");

        // Critic A24: while New Login holds before its server role, after DENY CONNECT SQL and DISABLE, another SQL login still signs in.
        if (windowsOnly) Console.WriteLine("New Login sign-in check (critic A24) skipped: this server accepts Windows authentication only.");
        else
        {
            var other = scratch.OwnLogin("conn");
            var otherPassword = ScratchDatabase.Throwaway();
            var made = await Sql("CREATE LOGIN [" + other + "] WITH PASSWORD = N'" + otherPassword + "', CHECK_POLICY = OFF, DEFAULT_DATABASE = [master];");
            var options = live("master");
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = options.Server, InitialCatalog = "master", UserID = other, Password = otherPassword, ConnectTimeout = 15, Pooling = false,
                TrustServerCertificate = options.TrustServerCertificate, ApplicationName = "Varia checks - A24"
            };
            long? signIn = null;
            string? signInError = null;
            var heldName = scratch.OwnLogin("held");
            actions.Options.BeforeStep = async (title, _) =>
            {
                if (title != "Add to a server role" || signIn is not null || signInError is not null) return;
                var clock = Stopwatch.StartNew();
                try
                {
                    await using var connection = new SqlConnection(builder.ConnectionString);
                    await connection.OpenAsync();
                    signIn = clock.ElapsedMilliseconds;
                }
                catch (SqlException error) { signInError = error.Number.ToString(System.Globalization.CultureInfo.InvariantCulture); }
            };
            try
            {
                var held = await actions.ExecuteAsync(Create(LoginChecks.Sql(heldName, false, false, false), password, ["dbcreator"], new("deny", false)), CancellationToken.None);
                check(made.Status == "completed" && held.Error is null && signIn is < 10_000,
                    "while New Login holds after DENY CONNECT SQL and DISABLE, another SQL login signs in at once (critic A24): "
                    + (signIn is { } ms ? ms + " ms" : "error " + signInError) + " | " + Steps(held));
            }
            finally { actions.Options.BeforeStep = null; }
        }

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_XE") == "1") await ExtendedEventsAsync(check, actions, info, scratch, Sql, With, Create);
        else Console.WriteLine("New Login Extended Events check (critic A16) skipped: it runs only where VARIA_TEST_SQL_XE=1 (CI's disposable SQL Server).");
    }

    /// <summary>Every CREATE LOGIN shape, for hostile names and passwords, as SQL Server builds it from the batch (the dry run selects
    /// @stmt), equals LoginSql.CreateStatement; a SQL Server login without its password fails the batch's guard.</summary>
    private static async Task DryRunsAsync(Action<bool, string> check, ActionService actions, ConnectionInfo info)
    {
        var names = new[] { "]", "'", "a]b'; DROP LOGIN sa; --", "line\nbreak", "x" + new string(']', 63) + new string('y', 64), "Fran]çais" };
        var passwords = new[] { "'", "＇", "]", "p'＇]x" + new string('q', 123), "", "Vx9!plain" };
        var wrong = new List<string>();
        var cases = 0;
        foreach (var language in new string?[] { null, "us]english'" })
        {
            foreach (var name in names)
            {
                var windows = LoginChecks.Windows("DOM]'\\" + name[..Math.Min(name.Length, 120)], "Ap]p'", language);
                if (await actions.DryRunCreateLoginAsync(info.Id, windows, null, CancellationToken.None) != LoginSql.CreateStatement(windows, null)) wrong.Add("windows " + name.Length);
                cases++;
                foreach (var (policy, expiration, mustChange) in new[] { (true, true, true), (true, true, false), (true, false, false), (false, false, false) })
                    foreach (var password in passwords)
                    {
                        var login = LoginChecks.Sql(name, policy, expiration, mustChange, "Ap]p'", language);
                        if (await actions.DryRunCreateLoginAsync(info.Id, login, password, CancellationToken.None) != LoginSql.CreateStatement(login, password)) wrong.Add("sql " + name.Length + "/" + password.Length);
                        cases++;
                    }
            }
        }
        check(wrong.Count == 0 && cases == 2 * 6 * (1 + 4 * 6), "SQL Server builds exactly LoginSql's CREATE LOGIN for hostile names, languages and passwords in every shape (" + cases + "): " + string.Join(", ", wrong.Take(5)));
        string? guard = null;
        try { await actions.DryRunCreateLoginAsync(info.Id, LoginChecks.Sql("x"), null, CancellationToken.None); }
        catch (SqlException error) { guard = error.Number + " " + error.Message; }
        check(guard == "50000 The password is missing.", "a SQL Server login's batch without its password stops at its guard: " + guard);
    }

    /// <summary>Critic A16: an Extended Events session records RPCs, batches and statements (their text, batch text, data stream and
    /// output parameters) while New Login creates a login and Create Catalog's master key batch runs, each with a throwaway password,
    /// and neither password appears in any field, as text, XML-escaped or as UTF-16 bytes.</summary>
    private static async Task ExtendedEventsAsync(Action<bool, string> check, ActionService actions, ConnectionInfo info, ScratchDatabase scratch, Func<string, string, int, Task<SqlRun>> sql,
        Func<Func<SqlConnection, Task<string?>>, Task<string?>> with, Func<NewLoginDto, string?, List<string>?, LoginStatusDto?, ActionArgs> create)
    {
        var session = scratch.OwnXeSession();
        const string fields = "SET collect_statement = (1), collect_data_stream = (1)";
        var events = new[]
        {
            "sqlserver.rpc_starting(" + fields + ")", "sqlserver.rpc_completed(" + fields + ", collect_output_parameters = (1))",
            "sqlserver.sql_batch_starting(SET collect_batch_text = (1))", "sqlserver.sql_batch_completed(SET collect_batch_text = (1))",
            "sqlserver.sp_statement_starting(SET collect_statement = (1))", "sqlserver.sp_statement_completed(SET collect_statement = (1))",
            "sqlserver.sql_statement_starting(SET collect_statement = (1))", "sqlserver.sql_statement_completed(SET collect_statement = (1))"
        };
        var definition = "CREATE EVENT SESSION [" + session + "] ON SERVER "
            + string.Join(", ", events.Select(item => "ADD EVENT " + item + " (ACTION (sqlserver.client_app_name, sqlserver.sql_text) "
                + "WHERE ([sqlserver].[is_system] = (0) AND [sqlserver].[like_i_sql_unicode_string]([sqlserver].[client_app_name], N'%Object Actions%')))"))
            + " ADD TARGET package0.ring_buffer (SET max_memory = (16384)) WITH (MAX_DISPATCH_LATENCY = 1 SECONDS, EVENT_RETENTION_MODE = NO_EVENT_LOSS);\n"
            + "ALTER EVENT SESSION [" + session + "] ON SERVER STATE = START;";
        var started = await sql(definition, "master", 300);
        check(started.Status == "completed", "the Extended Events session starts: " + started.Error);
        var database = await scratch.CreateLoginsDatabaseAsync();
        var loginPassword = "XeLogin-" + ScratchDatabase.Throwaway() + "'";
        var keyPassword = "XeKey-" + ScratchDatabase.Throwaway() + "'";
        var created = await actions.ExecuteAsync(create(LoginChecks.Sql(scratch.OwnLogin("xe"), false, false, false), loginPassword, ["dbcreator"], null), CancellationToken.None);
        var keyed = await with(async connection =>
        {
            connection.ChangeDatabase(database);
            await using var command = connection.CreateCommand();
            command.CommandText = SsisCreateSql.MasterKey.Text;
            command.Parameters.Add(SsisCreate.Name("@password", keyPassword));
            await command.ExecuteNonQueryAsync();
            return "done";
        });
        await Task.Delay(TimeSpan.FromSeconds(4));
        var data = await with(async connection =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT CONVERT(nvarchar(max), t.target_data) FROM sys.dm_xe_session_targets AS t JOIN sys.dm_xe_sessions AS s ON s.address = t.event_session_address "
                + "WHERE s.name = @name AND t.target_name = N'ring_buffer';";
            command.Parameters.Add(new SqlParameter("@name", System.Data.SqlDbType.NVarChar, 128) { Value = session });
            return (string?)await command.ExecuteScalarAsync();
        }) ?? "";
        static IEnumerable<string> Forms(string secret) =>
        [
            secret, secret.Replace("'", "''", StringComparison.Ordinal), System.Security.SecurityElement.Escape(secret)!, secret.Replace("'", "&apos;", StringComparison.Ordinal),
            Convert.ToHexString(Encoding.Unicode.GetBytes(secret)), secret[..^1]
        ];
        var leaks = new[] { ("New Login", loginPassword), ("Create Catalog", keyPassword) }
            .Where(item => Forms(item.Item2).Any(form => data.Contains(form, StringComparison.OrdinalIgnoreCase))).Select(item => item.Item1).ToList();
        var recorded = data.Contains("Object Actions", StringComparison.Ordinal) && data.Contains("rpc_starting", StringComparison.Ordinal);
        check(created.Error is null && keyed == "done" && recorded && leaks.Count == 0,
            "an Extended Events session recording RPCs, batches and statements sees neither New Login's nor Create Catalog's password (critic A16): "
            + (recorded ? "recorded" : "recorded nothing of the run") + (leaks.Count == 0 ? "" : "; the password of " + string.Join(" and ", leaks) + " appears"));
        Console.WriteLine("New Login Extended Events check (critic A16): " + (leaks.Count == 0 ? "no password in any recorded field." : "a password appears."));
    }
}
