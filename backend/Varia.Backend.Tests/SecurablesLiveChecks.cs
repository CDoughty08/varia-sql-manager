using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of the Securables page (PR D2d). Without scratch objects: dry runs (SELECT @stmt only) proving SQL Server builds
/// exactly Script's GRANT, DENY and REVOKE for every type and form with hostile 128-unit names, and New Login's describe of the lists.
/// With VARIA_TEST_SQL_SCRATCH=1, on the run's own SQL logins (VariaScratch_…_l…): New Login with a grant, a grant with grant option and
/// a deny; Login Properties' read of them and their grantor; REVOKE GRANT OPTION FOR, REVOKE and WITH GRANT OPTION, then DENY … CASCADE
/// over a grant option; SQL Server's refusal of a DENY without CASCADE there (4611), which the page never sends; the Effective tab's read
/// as the login, and its refusal as a value for a connection without IMPERSONATE. Passwords are throwaway and never printed.</summary>
internal static class SecurablesLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json, bool required = false)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var session = Guid.NewGuid().ToString();
            try
            {
                var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, session, database, text, Guid.NewGuid().ToString(), 100_000, 120, StopOnError: true));
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await Call<object>("query.session.close", new SessionArgs(session)); }
        }
        var actions = service.Actions;
        var securables = actions.Catalog.Logins.Securables;
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title + (step.Detail is null ? "" : "/" + step.Detail)));

        // Dry runs: every type and statement form, with hostile names for the grantee and the securable (neither need exist: the batch
        // returns its statement and runs nothing).
        var failures = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append("‮"))
        {
            var name = ActionChecks.Long(fragment);
            foreach (var type in securables.Types)
                foreach (var (state, cascade) in PermissionSql.Forms)
                {
                    var permission = new PermissionDto(new(type.Type, type.Type == "server" ? null : name), type.Permissions[^1], state, cascade);
                    var built = await actions.DryRunPermissionAsync(info.Id, name, permission, CancellationToken.None);
                    if (built != PermissionSql.Statement(securables, name, permission)) failures.Add(type.Type + " " + state + " " + fragment[..1]);
                }
        }
        check(failures.Count == 0, "SQL Server builds exactly Script's permission statements for every type and form with hostile 128-unit names: " + string.Join(", ", failures.Take(5)));

        // New Login's describe lists the server, the permissions it knows of the catalogue's, and its securables, never a fixed role.
        var described = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "newLogin", new("server")), CancellationToken.None);
        var serverName = (await Sql("SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ServerName'));")).Scalar;
        var lists = described.NewLogin?.Securables;
        check(lists is { Truncated: false } && lists.Server == serverName && lists.Permissions["server"].Contains("VIEW SERVER STATE") && lists.Permissions["server"].Contains("CONNECT SQL")
                && securables.Types.All(type => lists.Permissions[type.Type].SequenceEqual(type.Permissions.Where(lists.Permissions[type.Type].Contains)))
                && lists.Permissions["login"].SequenceEqual(securables.Type("login")!.Permissions)
                && lists.Objects["login"].Contains("sa") && lists.Objects["endpoint"].Count > 0 && !lists.Objects["serverRole"].Contains("sysadmin") && !lists.Objects["serverRole"].Contains("public")
                && PermissionSql.DescribeOrder.All(lists.Objects.ContainsKey),
            "New Login's describe lists the server's name, the catalogue's permissions this server knows in its order, and the endpoints, logins and user server roles: " + described.Error?.Message);

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            check(!required, "the Securables lane needs VARIA_TEST_SQL_SCRATCH=1");
            Console.WriteLine("Securables scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping uniquely named logins on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        if (!await scratch.CreateLoginAsync())
        {
            check(!required, "the Securables lane needs a server that takes SQL Server logins");
            Console.WriteLine("Securables scratch checks skipped: the server accepts Windows logins only.");
            return;
        }
        var own = (await Sql("SELECT SUSER_SNAME();")).Scalar ?? "";
        var holder = scratch.OwnLogin("sec");
        var target = scratch.OwnLogin("sect");
        var password = ScratchDatabase.Throwaway();
        var setUp = await Sql("CREATE LOGIN " + Bracket(target) + " WITH PASSWORD = " + Literal(ScratchDatabase.Throwaway()) + ", CHECK_POLICY = OFF;");
        check(setUp.Status == "completed", "the Securables checks' second login is created: " + setUp.Error);
        SqlRun? dropped = null;
        try
        {
            // The login's explicit server permissions other than CONNECT SQL: class, securable, permission and state, in a stable order.
            async Task<string> Permissions(string name) => string.Join(";", (await Sql("SELECT CONVERT(nvarchar(3), sp.class), ISNULL(s.name, N''), sp.permission_name, sp.state "
                + "FROM sys.server_permissions AS sp LEFT JOIN sys.server_principals AS s ON sp.class = 101 AND s.principal_id = sp.major_id "
                + "WHERE sp.grantee_principal_id = SUSER_ID(" + Literal(name) + ") AND sp.type <> 'COSQ' ORDER BY sp.class, s.name, sp.permission_name;")).Sets.SelectMany(set => set).Select(row => string.Join("|", row)));
            PermissionDto Server(string permission, string state, bool? cascade = null) => new(new("server"), permission, state, cascade);
            PermissionDto OnTarget(string permission, string state, bool? cascade = null) => new(new("login", target), permission, state, cascade);

            // New Login: a deny, a grant and a grant with grant option, after CREATE LOGIN, in the plan's order.
            var created = await actions.ExecuteAsync(new ActionArgs("createLogin", info.Id, Guid.NewGuid().ToString(), new("server"), Login: LoginChecks.Sql(holder, policy: false, expiration: false, mustChange: false),
                ServerRoles: [], Status: new("grant", true), Mappings: [], Secrets: new(password),
                Permissions: [OnTarget("IMPERSONATE", "grant"), Server("VIEW ANY DATABASE", "withGrant"), Server("SHUTDOWN", "deny")]), CancellationToken.None);
            var createdState = await Permissions(holder);
            check(created.Error is null && Steps(created) == "done:Create the login, done:Deny a permission/SHUTDOWN, done:Grant a permission/VIEW ANY DATABASE, done:Grant a permission/IMPERSONATE on " + target
                    && createdState == "100||SHUTDOWN|D;100||VIEW ANY DATABASE|W;101|" + target + "|IMPERSONATE|G",
                "New Login grants, grants with grant option and denies after CREATE LOGIN, the server's first: " + Steps(created) + " " + created.Error?.Message + " " + createdState);

            // Login Properties reads them with their grantor; the Effective tab reads what the login may do, as the login.
            var properties = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "loginProperties", new("login", Name: holder)), CancellationToken.None);
            var rows = properties.LoginProperties?.Permissions ?? [];
            // SQL Server records who granted each permission (a sysadmin's grants on the server name sa, whoever ran them): the describe reads it.
            var grantors = (await Sql("SELECT sp.permission_name, g.name FROM sys.server_permissions AS sp JOIN sys.server_principals AS g ON g.principal_id = sp.grantor_principal_id "
                + "WHERE sp.grantee_principal_id = SUSER_ID(" + Literal(holder) + ");")).Sets.SelectMany(set => set).ToDictionary(row => row[0]!, row => row[1] ?? "");
            string Grantor(string permission) => grantors.TryGetValue(permission, out var name) ? name : "?";
            check(properties.Error is null && properties.LoginProperties!.PermissionsTruncated == false && rows.Count == 4 && grantors.Values.All(name => name.Length > 0)
                    && rows.Contains(new ExplicitPermissionDto(new("server"), "SHUTDOWN", "deny", Grantor("SHUTDOWN"))) && rows.Contains(new ExplicitPermissionDto(new("server"), "VIEW ANY DATABASE", "withGrant", Grantor("VIEW ANY DATABASE")))
                    && rows.Contains(new ExplicitPermissionDto(new("login", target), "IMPERSONATE", "grant", Grantor("IMPERSONATE"))) && rows.Contains(new ExplicitPermissionDto(new("server"), "CONNECT SQL", "grant", Grantor("CONNECT SQL"))),
                "Login Properties reads the login's explicit permissions, CONNECT SQL among them, with their grantor: " + properties.Error?.Message + " " + string.Join(", ", rows.Select(row => row.Securable.Type + ":" + row.Permission + ":" + row.State + ":" + (row.Grantor == Grantor(row.Permission) ? "read" : "other"))));
            Task<ActionDescribeResult> Effective(SecurableRefDto securable, string? connectionId = null) =>
                actions.DescribeAsync(new ActionDescribeArgs(connectionId ?? info.Id, Guid.NewGuid().ToString(), securables.EffectiveDescribe, new("login", Name: holder), Securable: securable), CancellationToken.None);
            var onServer = await Effective(new("server"));
            var onTarget = await Effective(new("login", target));
            var after = (await Sql("SELECT SUSER_SNAME();")).Scalar;
            check(onServer is { Error: null, EffectivePermissions.Truncated: false } && onServer.EffectivePermissions.Permissions.Contains("CONNECT SQL") && onServer.EffectivePermissions.Permissions.Contains("VIEW ANY DATABASE")
                    && !onServer.EffectivePermissions.Permissions.Contains("SHUTDOWN") && onTarget.EffectivePermissions?.Permissions.Contains("IMPERSONATE") == true && after == own,
                "the Effective tab reads, as the login, what it may do on the server and on a login, and the connection is itself again after: " + onServer.Error?.Message + " " + onTarget.Error?.Message);

            // Script shows the statements and runs nothing; OK clears With Grant (REVOKE GRANT OPTION FOR … CASCADE), revokes the deny and grants
            // with grant option over a grant.
            var identity = properties.Login is { } facts ? new LoginIdentityDto(facts.Sid, facts.Created) : null;
            ActionArgs Change(params PermissionDto[] permissions) =>
                new("loginProperties", info.Id, Guid.NewGuid().ToString(), new("login", Name: holder), LoginIdentity: identity, LoginChanges: new(Permissions: [.. permissions]));
            var first = Change(Server("VIEW ANY DATABASE", "revokeGrantOption"), Server("SHUTDOWN", "revoke"), OnTarget("IMPERSONATE", "withGrant"));
            var script = await actions.ScriptAsync(first, CancellationToken.None);
            var unchanged = await Permissions(holder);
            var applied = await actions.ExecuteAsync(first, CancellationToken.None);
            check(script.Error is null && script.Text == "USE [master]" + PermissionSql.NL + "GO" + PermissionSql.NL + "REVOKE SHUTDOWN TO " + Bracket(holder) + PermissionSql.NL + "GO" + PermissionSql.NL
                    + "REVOKE GRANT OPTION FOR VIEW ANY DATABASE TO " + Bracket(holder) + " CASCADE" + PermissionSql.NL + "GO" + PermissionSql.NL
                    + "GRANT IMPERSONATE ON LOGIN::" + Bracket(target) + " TO " + Bracket(holder) + " WITH GRANT OPTION" + PermissionSql.NL + "GO" + PermissionSql.NL
                && unchanged == "100||SHUTDOWN|D;100||VIEW ANY DATABASE|W;101|" + target + "|IMPERSONATE|G"
                && applied.Error is null && await Permissions(holder) == "100||VIEW ANY DATABASE|G;101|" + target + "|IMPERSONATE|W",
                "Login Properties scripts and then runs REVOKE, REVOKE GRANT OPTION FOR … CASCADE and GRANT … WITH GRANT OPTION: " + Steps(applied) + " " + applied.Error?.Message + " " + script.Error?.Message);

            // SQL Server refuses to deny a grantable permission without CASCADE (4611), a value with the step that failed; the page always sends it.
            var bare = await actions.ExecuteAsync(Change(OnTarget("IMPERSONATE", "deny")), CancellationToken.None);
            var cascaded = await actions.ExecuteAsync(Change(OnTarget("IMPERSONATE", "deny", true), Server("VIEW ANY DATABASE", "revoke")), CancellationToken.None);
            check(bare.Error is not null && Steps(bare).StartsWith("failed:Deny a permission", StringComparison.Ordinal)
                    && cascaded.Error is null && await Permissions(holder) == "101|" + target + "|IMPERSONATE|D",
                "DENY over a grant option needs CASCADE, which the page sends; REVOKE removes a grant: " + bare.Error?.Code + " " + Steps(cascaded) + " " + cascaded.Error?.Message);

            // A connection without IMPERSONATE on the login (the run's low-privilege login, which may only see it) gets the Effective tab's words.
            var see = await Sql("GRANT VIEW DEFINITION ON LOGIN::" + Bracket(holder) + " TO " + Bracket(scratch.Login!) + ";");
            var low = await Call<ConnectionInfo>("connections.connect", live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password, Database = "master" });
            try
            {
                var denied = await Effective(new("server"), low.Id);
                check(see.Status == "completed" && denied is { Error.Code: "PERMISSION_DENIED", EffectivePermissions: null } && denied.Error.Message == securables.EffectiveDenied,
                    "without IMPERSONATE the Effective tab's read is a value that says so: " + denied.Error?.Code + " " + denied.Error?.Message);
            }
            finally { await Call<object>("connections.disconnect", new ConnectionArgs(low.Id)); }
            var missing = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), securables.EffectiveDescribe, new("login", Name: scratch.LoginNamed("none")), Securable: new("server")), CancellationToken.None);
            check(missing.Error?.Code == "NOT_FOUND", "the Effective tab's read of a login that no longer exists says so: " + missing.Error?.Code);
        }
        finally
        {
            // SQL Server records a grant ON LOGIN::x as granted by x, so x drops only once the grants it made are gone: the low-privilege
            // login's view of the holder first (that login drops last, with the scratch name), then the holder, then the second login.
            if (scratch.Login is { } lowLogin) await Sql("IF SUSER_ID(" + Literal(holder) + ") IS NOT NULL AND SUSER_ID(" + Literal(lowLogin) + ") IS NOT NULL REVOKE VIEW DEFINITION ON LOGIN::" + Bracket(holder) + " FROM " + Bracket(lowLogin) + " CASCADE;");
            dropped = await Sql("IF SUSER_ID(" + Literal(holder) + ") IS NOT NULL DROP LOGIN " + Bracket(holder) + ";\nIF SUSER_ID(" + Literal(target) + ") IS NOT NULL DROP LOGIN " + Bracket(target) + ";");
        }
        check(dropped?.Status == "completed", "the Securables checks' logins drop: " + dropped?.Error);
    }
}
