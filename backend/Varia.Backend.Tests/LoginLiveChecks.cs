using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR D2a, New Login. Without scratch objects: the CREATE LOGIN SQL Server builds from the batch, for hostile
/// names and passwords in every shape, is the statement LoginSql writes, and a NULL password creates nothing. With
/// VARIA_TEST_SQL_SCRATCH=1, on SQL logins named VariaScratch_…_l…: New Login's describe; a real create through ActionService
/// (PWDCOMPARE, options, language, Deny, Disabled, a server role); a role that does not exist failing after the login was created,
/// which stays and is said to first (with a one-letter password too); Stop before a role and before Deny, each reply starting with
/// the login's real state; errors as values (a name in use, a missing database and language, a Windows account, the password
/// policy), none holding the password; no cached plan holding it; critic A24's checks that a held New Login keeps no SQL login
/// out, a first sign-in included, and what an open transaction holding CREATE LOGIN or a role change would keep out; critic A14's
/// unedited Script running nothing; User Mapping (D2b, LoginMappingLiveChecks); and that the Extended Events check's events and fields exist. With VARIA_TEST_SQL_XE=1 too
/// (CI's disposable container only, decision 14): an Extended Events session records RPCs and batches while New Login and Create
/// Catalog's master key run, and must not hold either password (critic A16). Passwords are throwaway and never printed.</summary>
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

        // A server role that does not exist fails after the login was created: the login stays, and the reply says so first.
        var partialName = scratch.OwnLogin("part");
        var partial = await actions.ExecuteAsync(Create(LoginChecks.Sql(partialName, false, false, false), password, ["dbcreator", "VariaNoSuchRole"]), CancellationToken.None);
        var partialExists = (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name = N'" + partialName + "';")).Scalar;
        check(partial.Error is { } partialError && partialError.Message.StartsWith(ActionService.LoginCreatedMessage + " " + ActionService.LoginRolesMessage + " ", StringComparison.Ordinal)
            && partialExists == "1" && !Holds(partial, password) && Steps(partial) == "done:Create the login, done:Add to a server role/dbcreator, failed:Add to a server role/VariaNoSuchRole",
            "a role that does not exist fails after the login was created, which stays, and the reply says so first and lists the steps: " + Steps(partial) + " | " + partial.Error?.Code);
        // The same with a one-letter password, which the policy off allows: the scrubber leaves SQL Server's words and Varia's own whole.
        var shortName = scratch.OwnLogin("short");
        var shortRun = await actions.ExecuteAsync(Create(LoginChecks.Sql(shortName, false, false, false), "e", ["dbcreator", "VariaNoSuchRole"]), CancellationToken.None);
        check(shortRun.Error?.Message is { } shortMessage && shortMessage.StartsWith(ActionService.LoginCreatedMessage + " ", StringComparison.Ordinal) && shortMessage.Contains("VariaNoSuchRole", StringComparison.Ordinal)
            && shortMessage.EndsWith("Completed before the failure: Create the login, Add to a server role.", StringComparison.Ordinal) && !shortMessage.Contains(LoginSql.Placeholder, StringComparison.Ordinal)
            && shortRun.Steps[^1].Message is { } stepMessage && stepMessage.Contains("VariaNoSuchRole", StringComparison.Ordinal),
            "with a one-letter password, a failed server role's message keeps SQL Server's words and Varia's sentences whole: " + shortRun.Error?.Message);

        // Stop: SSMS's statements ran one by one, so the login stays, and the reply starts with its real state.
        async Task StopAt(string tag, string title, LoginStatusDto status, string steps, string state, string connect, string disabled, string expected)
        {
            var stopName = scratch.OwnLogin(tag);
            using var stop = new CancellationTokenSource();
            actions.Options.BeforeStep = (step, _) => { if (step == title) stop.Cancel(); return Task.CompletedTask; };
            try
            {
                ActionExecuteResult? stopped = null;
                try { stopped = await actions.ExecuteAsync(Create(LoginChecks.Sql(stopName, false, false, false), password, ["dbcreator"], status), stop.Token); }
                catch (OperationCanceledException) { }
                var row = (await Sql("SELECT COUNT(*), ISNULL(MAX(p.state), N'G'), MAX(CONVERT(int, l.is_disabled)) FROM sys.server_principals AS l "
                    + "LEFT JOIN sys.server_permissions AS p ON p.grantee_principal_id = l.principal_id AND p.type = 'COSQ' WHERE l.name = N'" + stopName + "';")).Sets[0][0];
                check(stopped is { Error.Code: "CANCELLED" } && stopped.Error.Message.StartsWith(ActionService.LoginCreatedMessage + state + " The action was stopped", StringComparison.Ordinal)
                    && row is ["1", var granted, var off] && granted == connect && off == disabled && Steps(stopped) == steps && !Holds(stopped, password),
                    expected + (stopped is null ? "an unknown outcome" : Steps(stopped) + " | " + stopped.Error?.Message));
            }
            finally { actions.Options.BeforeStep = null; }
        }
        await StopAt("stop", "Add to a server role", new("deny", true), "done:Create the login, done:Deny permission to connect, cancelled:Add to a server role/dbcreator",
            " " + ActionService.LoginRolesMessage, "D", "0", "Stop before a server role answers CANCELLED with what completed, and says first that the login was created without it: ");
        await StopAt("stopden", "Deny permission to connect", new("deny", false), "done:Create the login, cancelled:Deny permission to connect, skipped:Disable the login, skipped:Add to a server role/dbcreator",
            " " + ActionService.LoginCanConnectMessage + " " + ActionService.LoginEnabledMessage + " " + ActionService.LoginRolesMessage, "G", "0",
            "Stop before Deny says the login was created and can connect and is enabled, unlike the status chosen: ");

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

        // Critic A24 and owner decision 6: New Login holds nothing open between its statements, so other SQL Server logins sign in
        // while it waits. Each hold signs in a login that never signed in before: its security token is not cached, which is what
        // an open transaction holding CREATE LOGIN blocks (a login that signed in before goes through).
        if (windowsOnly) Console.WriteLine("New Login sign-in checks (critic A24) skipped: this server accepts Windows authentication only.");
        else
        {
            var options = live("master");
            var made = new List<string>();
            async Task<SqlConnectionStringBuilder> FreshLogin(string tag)
            {
                var other = scratch.OwnLogin(tag);
                var otherPassword = ScratchDatabase.Throwaway();
                made.Add((await Sql("CREATE LOGIN [" + other + "] WITH PASSWORD = N'" + otherPassword + "', CHECK_POLICY = OFF, DEFAULT_DATABASE = [master];")).Status);
                return new SqlConnectionStringBuilder
                {
                    DataSource = options.Server, InitialCatalog = "master", UserID = other, Password = otherPassword, ConnectTimeout = 15, Pooling = false,
                    TrustServerCertificate = options.TrustServerCertificate, ApplicationName = "Varia checks - A24"
                };
            }
            static async Task<string> SignInAsync(SqlConnectionStringBuilder builder)
            {
                var clock = Stopwatch.StartNew();
                try
                {
                    await using var connection = new SqlConnection(builder.ConnectionString);
                    await connection.OpenAsync();
                    return "signed in";
                }
                catch (SqlException error) { return "error " + error.Number.ToString(CultureInfo.InvariantCulture) + " after " + clock.ElapsedMilliseconds + " ms"; }
            }
            var fresh = new Queue<SqlConnectionStringBuilder>();
            foreach (var tag in new[] { "conn1", "conn2", "conn3", "conn4" }) fresh.Enqueue(await FreshLogin(tag));
            var warm = fresh.Peek();
            var signIns = new List<string>();
            var heldName = scratch.OwnLogin("held");
            actions.Options.BeforeStep = async (title, _) =>
            {
                if (title != ActionService.CreateLoginStep && fresh.TryDequeue(out var builder)) signIns.Add(title + ": " + await SignInAsync(builder));
            };
            try
            {
                var held = await actions.ExecuteAsync(Create(LoginChecks.Sql(heldName, false, false, false), password, ["dbcreator", "bulkadmin"], new("deny", false)), CancellationToken.None);
                check(made.All(status => status == "completed") && held.Error is null && signIns.Count == 4 && signIns.All(item => item.EndsWith(": signed in", StringComparison.Ordinal)),
                    "while New Login holds before Deny, Disable and each server role, a SQL Server login signing in for the first time gets in (critic A24): "
                    + string.Join(", ", signIns) + " | " + Steps(held));
            }
            finally { actions.Options.BeforeStep = null; }

            // Why New Login keeps to SSMS's order (owner decision 6's fallback): held in an open transaction, a CREATE LOGIN keeps a
            // first sign-in out, and a server role membership change keeps out a login that signed in before too. Each is held here
            // for at most the sign-in's 3 seconds, then rolled back. Measured on SQL Server 2025, where it fails if that changes;
            // other versions report what they do.
            var cold = await FreshLogin("cold");
            async Task<string> HeldAsync(string tag, string statements, SqlConnectionStringBuilder signer)
            {
                var target = scratch.OwnLogin(tag);
                return await With(async connection =>
                {
                    await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync();
                    try
                    {
                        await using (var command = connection.CreateCommand())
                        {
                            command.Transaction = transaction;
                            command.CommandText = "CREATE LOGIN [" + target + "] WITH PASSWORD = N'" + ScratchDatabase.Throwaway() + "', CHECK_POLICY = OFF;" + statements.Replace("{0}", target, StringComparison.Ordinal);
                            await command.ExecuteNonQueryAsync();
                        }
                        return await SignInAsync(new SqlConnectionStringBuilder(signer.ConnectionString) { ConnectTimeout = 3 });
                    }
                    finally { await transaction.RollbackAsync(); }
                });
            }
            var heldCreate = await HeldAsync("mechc", "", cold);
            var heldRole = await HeldAsync("mechr", "\nALTER SERVER ROLE [dbcreator] ADD MEMBER [{0}];", warm);
            var left = (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name IN (N'" + scratch.LoginNamed("mechc") + "', N'" + scratch.LoginNamed("mechr") + "');")).Scalar;
            var major = (await Sql("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion'));")).Scalar;
            var outcome = "a first sign-in while CREATE LOGIN is held: " + heldCreate + "; a returning sign-in while a role membership change is held: " + heldRole;
            if (major is not null && int.Parse(major, CultureInfo.InvariantCulture) >= 17)
                check(heldCreate.StartsWith("error ", StringComparison.Ordinal) && heldRole.StartsWith("error ", StringComparison.Ordinal) && left == "0",
                    "held in an open transaction, CREATE LOGIN keeps a first sign-in out and a server role membership change keeps every SQL Server login out, "
                    + "which is why New Login runs SSMS's statements one by one (critic A24): " + outcome);
            else
            {
                check(left == "0", "the held transactions of the sign-in probe roll back: " + left);
                Console.WriteLine("New Login sign-in probe (critic A24, SQL Server " + major + "): " + outcome + ".");
            }
        }

        await ScriptRunsNothingAsync(check, actions, info, scratch, Sql);
        await LoginMappingLiveChecks.RunAsync(check, actions, info, scratch, Sql);

        await ExtendedEventsDefinedAsync(check, Sql);
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_XE") == "1") await ExtendedEventsAsync(check, actions, info, scratch, Sql, With, Create);
        else Console.WriteLine("New Login Extended Events check (critic A16) skipped: it runs only where VARIA_TEST_SQL_XE=1 (CI's disposable SQL Server).");
    }

    /// <summary>Critic A14 on the server: a SQL Server login's unedited Script fails to parse (102) and runs nothing, so it creates no
    /// login, and gives no server role to a login that already has the name.</summary>
    private static async Task ScriptRunsNothingAsync(Action<bool, string> check, ActionService actions, ConnectionInfo info, ScratchDatabase scratch, Func<string, string, int, Task<SqlRun>> sql)
    {
        async Task<SqlRun> RunScript(string name)
        {
            var args = LoginChecks.Create(LoginChecks.Sql(name, false, false, false), null, ["dbcreator"], new("deny", false)) with { ConnectionId = info.Id, Secrets = null };
            var script = await actions.ScriptAsync(args, CancellationToken.None);
            return await sql(script.Text ?? "", "master", 300);
        }
        async Task<string?> State(string name) => (await sql("SELECT CONVERT(varchar(1), COUNT(*)) + ',' + CONVERT(varchar(1), ISNULL(MAX(CASE WHEN IS_SRVROLEMEMBER(N'dbcreator', l.name) = 1 THEN 1 ELSE 0 END), 0)) "
            + "FROM sys.server_principals AS l WHERE l.name = N'" + name + "';", "master", 300)).Scalar;
        var fresh = scratch.OwnLogin("script");
        var unedited = await RunScript(fresh);
        var existing = scratch.OwnLogin("exists");
        var made = await sql("CREATE LOGIN [" + existing + "] WITH PASSWORD = N'" + ScratchDatabase.Throwaway() + "', CHECK_POLICY = OFF;", "master", 300);
        var over = await RunScript(existing);
        check(unedited.Status != "completed" && (unedited.Error ?? "").Contains("Incorrect syntax", StringComparison.Ordinal) && await State(fresh) == "0,0"
            && made.Status == "completed" && over.Status != "completed" && await State(existing) == "1,0",
            "an unedited New Login script fails to parse and runs nothing: no login, and no server role for a login that already has the name (critic A14): "
            + unedited.Status + " " + unedited.Error);
    }

    /// <summary>The Extended Events the A16 check records, each with the fields it switches on.</summary>
    private static readonly (string Event, string[] Fields)[] XeEvents =
    [
        ("rpc_starting", ["collect_statement", "collect_data_stream"]), ("rpc_completed", ["collect_statement", "collect_data_stream", "collect_output_parameters"]),
        ("sql_batch_starting", ["collect_batch_text"]), ("sql_batch_completed", ["collect_batch_text"]),
        ("sp_statement_starting", ["collect_statement"]), ("sp_statement_completed", ["collect_statement"]),
        ("sql_statement_starting", ["collect_statement"]), ("sql_statement_completed", ["collect_statement"])
    ];
    /// <summary>The actions and predicate the A16 session uses, by object type.</summary>
    private static readonly (string Type, string Name)[] XeObjects = [("action", "client_app_name"), ("action", "sql_text"), ("pred_source", "is_system"), ("pred_compare", "like_i_sql_unicode_string")];

    /// <summary>Read only, on every scratch run: every event, field, action and predicate the A16 session names exists on this server,
    /// so its CREATE EVENT SESSION binds where only CI runs it.</summary>
    private static async Task ExtendedEventsDefinedAsync(Action<bool, string> check, Func<string, string, int, Task<SqlRun>> sql)
    {
        var listed = await sql("SELECT o.object_type + ':' + o.name + ':' + ISNULL(c.name, N'') FROM sys.dm_xe_objects AS o JOIN sys.dm_xe_packages AS p ON p.guid = o.package_guid "
            + "LEFT JOIN sys.dm_xe_object_columns AS c ON c.object_name = o.name AND c.object_package_guid = o.package_guid AND c.column_type = 'customizable' "
            + "WHERE p.name = N'sqlserver' AND o.object_type IN (N'event', N'action', N'pred_source', N'pred_compare');", "master", 300);
        var known = listed.Sets.Count == 0 ? new HashSet<string>() : listed.Sets[0].Select(row => row[0] ?? "").ToHashSet(StringComparer.Ordinal);
        var missing = XeEvents.SelectMany(item => item.Fields.Select(field => "event:" + item.Event + ":" + field))
            .Concat(XeObjects.Select(item => item.Type + ":" + item.Name + ":")).Where(name => !known.Contains(name)).ToList();
        check(listed.Status == "completed" && missing.Count == 0, "every event, field, action and predicate the Extended Events check names exists on this server: " + string.Join(", ", missing));
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

    /// <summary>What shows that the A16 session recorded New Login's CREATE LOGIN batch (its password guard), Create Catalog's master key
    /// batch and Login Properties' password batch with Specify old password (its old password's guard): either as text or as UTF-16
    /// bytes, or SQL Server's notice that it replaced an event's text for security, or the mask SQL Server 2022 records in place of a
    /// statement that holds a password ("*password" and dashes, seen on SQL Server 2022 on Linux).</summary>
    internal const string XeLoginMarker = "@password IS NULL THROW", XeKeyMarker = "CREATE MASTER KEY ENCRYPTION BY PASSWORD", XeOldMarker = "The old password is missing",
        XeMasked = "for security reasons", XeMaskedStatement = "*password--";

    /// <summary>Critic A16: an Extended Events session records RPCs, batches and statements (their text, batch text, data stream and
    /// output parameters) while New Login creates a login, Create Catalog's master key batch runs and Login Properties changes a login's
    /// password with its old one (@password and @old_password), each with throwaway passwords. It reads the ring buffer until each run's
    /// password-bearing RPC is seen completed (or 30 seconds pass, which fails), then no password may appear in any field, as text,
    /// doubled quotes, XML-escaped or as UTF-16 bytes.</summary>
    private static async Task ExtendedEventsAsync(Action<bool, string> check, ActionService actions, ConnectionInfo info, ScratchDatabase scratch, Func<string, string, int, Task<SqlRun>> sql,
        Func<Func<SqlConnection, Task<string?>>, Task<string?>> with, Func<NewLoginDto, string?, List<string>?, LoginStatusDto?, ActionArgs> create)
    {
        check(LoginSql.PasswordGuard.Contains(XeLoginMarker, StringComparison.Ordinal) && SsisCreateSql.MasterKey.Text.Contains(XeKeyMarker, StringComparison.Ordinal)
                && LoginSql.PasswordExecutable(new(true, false, false)).Contains(XeOldMarker, StringComparison.Ordinal),
            "the Extended Events check's markers are in New Login's, Create Catalog's and Login Properties' password batches");
        var session = scratch.OwnXeSession();
        var definition = "CREATE EVENT SESSION [" + session + "] ON SERVER "
            + string.Join(", ", XeEvents.Select(item => "ADD EVENT sqlserver." + item.Event + "(SET " + string.Join(", ", item.Fields.Select(field => field + " = (1)")) + " "
                + "ACTION (sqlserver.client_app_name, sqlserver.sql_text) "
                + "WHERE ([sqlserver].[is_system] = (0) AND [sqlserver].[like_i_sql_unicode_string]([sqlserver].[client_app_name], N'%Object Actions%')))"))
            + " ADD TARGET package0.ring_buffer (SET max_memory = (16384)) WITH (MAX_DISPATCH_LATENCY = 1 SECONDS, EVENT_RETENTION_MODE = NO_EVENT_LOSS);\n"
            + "ALTER EVENT SESSION [" + session + "] ON SERVER STATE = START;";
        var started = await sql(definition, "master", 300);
        check(started.Status == "completed", "the Extended Events session starts: " + started.Error);
        async Task<DateTime> ServerNow() => DateTime.Parse((await sql("SELECT CONVERT(varchar(27), SYSUTCDATETIME(), 126);", "master", 300)).Scalar!, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
        var database = await scratch.CreateLoginsDatabaseAsync();
        var loginPassword = "XeLogin-" + ScratchDatabase.Throwaway() + "'";
        var keyPassword = "XeKey-" + ScratchDatabase.Throwaway() + "'";
        var before = await ServerNow();
        var created = await actions.ExecuteAsync(create(LoginChecks.Sql(scratch.OwnLogin("xe"), false, false, false), loginPassword, ["dbcreator"], null), CancellationToken.None);
        var between = await ServerNow();
        var keyed = await with(async connection =>
        {
            connection.ChangeDatabase(database);
            await using var command = connection.CreateCommand();
            command.CommandText = SsisCreateSql.MasterKey.Text;
            command.Parameters.Add(SsisCreate.Name("@password", keyPassword));
            await command.ExecuteNonQueryAsync();
            return "done";
        });
        var after = await ServerNow();
        // Login Properties' password with Specify old password, on a login of the run's own.
        var changing = scratch.OwnLogin("xeprops");
        var oldPassword = "XeOld-" + ScratchDatabase.Throwaway() + "'";
        var newPassword = "XeNew-" + ScratchDatabase.Throwaway() + "'";
        var made = await sql("CREATE LOGIN [" + changing.Replace("]", "]]", StringComparison.Ordinal) + "] WITH PASSWORD = N'" + oldPassword.Replace("'", "''", StringComparison.Ordinal) + "', CHECK_POLICY = OFF;", "master", 300);
        var described = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "loginProperties", new ObjectRefDto("login", Name: changing)), CancellationToken.None);
        var propertiesStart = await ServerNow();
        var changed = await actions.ExecuteAsync(new ActionArgs("loginProperties", info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("login", Name: changing), Secrets: new(newPassword, oldPassword),
            LoginIdentity: described.Login is { } facts ? new(facts.Sid, facts.Created) : null, LoginChanges: new(Password: new(true, false, false))), CancellationToken.None);
        var propertiesEnd = await ServerNow();
        async Task<string> Read() => await with(async connection =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT CONVERT(nvarchar(max), t.target_data) FROM sys.dm_xe_session_targets AS t JOIN sys.dm_xe_sessions AS s ON s.address = t.event_session_address "
                + "WHERE s.name = @name AND t.target_name = N'ring_buffer';";
            command.Parameters.Add(new SqlParameter("@name", System.Data.SqlDbType.NVarChar, 128) { Value = session });
            return (string?)await command.ExecuteScalarAsync();
        }) ?? "";
        // Each event: its name, when it fired (UTC) and every value it holds, unescaped.
        static List<(string Name, DateTime At, string Text)> Events(string xml) => xml.Length == 0 ? [] : [.. XDocument.Parse(xml).Root!.Elements("event").Select(item =>
            (item.Attribute("name")?.Value ?? "", DateTime.Parse(item.Attribute("timestamp")?.Value ?? "", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal),
                string.Join("\n", item.Descendants("value").Select(value => value.Value))))];
        static bool Seen(List<(string Name, DateTime At, string Text)> events, DateTime from, DateTime to, string marker) => events.Any(item => item.Name == "rpc_completed"
            && item.At >= from && item.At <= to && (item.Text.Contains(marker, StringComparison.Ordinal) || item.Text.Contains(Convert.ToHexString(Encoding.Unicode.GetBytes(marker)), StringComparison.OrdinalIgnoreCase)
                || item.Text.Contains(XeMasked, StringComparison.Ordinal) || item.Text.Contains(XeMaskedStatement, StringComparison.Ordinal)));
        var data = "";
        bool login = false, key = false, properties = false;
        var waited = Stopwatch.StartNew();
        while (true)
        {
            data = await Read();
            var events = Events(data);
            login = Seen(events, before, between, XeLoginMarker);
            key = Seen(events, between, after, XeKeyMarker);
            properties = Seen(events, propertiesStart, propertiesEnd, XeOldMarker);
            if ((login && key && properties) || waited.Elapsed > TimeSpan.FromSeconds(30)) break;
            await Task.Delay(250);
        }
        static IEnumerable<string> Forms(string secret) =>
        [
            secret, secret.Replace("'", "''", StringComparison.Ordinal), System.Security.SecurityElement.Escape(secret)!, secret.Replace("'", "&apos;", StringComparison.Ordinal),
            Convert.ToHexString(Encoding.Unicode.GetBytes(secret)), secret[..^1]
        ];
        var leaks = new[] { ("New Login", loginPassword), ("Create Catalog", keyPassword), ("Login Properties", newPassword), ("Login Properties' old", oldPassword) }
            .Where(item => Forms(item.Item2).Any(form => data.Contains(form, StringComparison.OrdinalIgnoreCase))).Select(item => item.Item1).ToList();
        var unseen = new[] { (login, "New Login"), (key, "Create Catalog"), (properties, "Login Properties") }.Where(item => !item.Item1).Select(item => item.Item2).ToList();
        check(created.Error is null && keyed == "done" && made.Status == "completed" && changed.Error is null && unseen.Count == 0 && leaks.Count == 0,
            "an Extended Events session recording RPCs, batches and statements sees none of New Login's, Create Catalog's and Login Properties' passwords (critic A16): "
            + (unseen.Count == 0 ? "every run recorded" : "recorded nothing of " + string.Join(" or ", unseen)) + (leaks.Count == 0 ? "" : "; the password of " + string.Join(" and ", leaks) + " appears")
            + (changed.Error is null ? "" : "; Login Properties failed: " + changed.Error.Code));
        Console.WriteLine("New Login Extended Events check (critic A16): " + (unseen.Count > 0 ? "a run was not recorded." : leaks.Count == 0 ? "no password in any recorded field." : "a password appears."));
    }
}
