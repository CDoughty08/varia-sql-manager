using Microsoft.Data.SqlClient;
using Varia.Backend;
using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>The proxy and credential documents (AG-8b), offline: the proxy batch lint and the credential builder's lint with their near misses,
/// the proxy save planner (New Proxy, an existing proxy's changed arguments, indexed grants and revokes, the inline credential), Rename and
/// Delete, the requests' validation, the refusal mapping, the scripts (which write &lt;secret&gt;), and that no message or record prints the
/// secret.</summary>
internal static class AgentProxyChecks
{
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly ObjectRefDto AgentNode = new("agent");
    private static readonly ObjectRefDto Server = new("server");
    private static readonly ObjectRefDto Proxy = new("agentProxy", Name: "Run ']' -- as");
    private static readonly ObjectRefDto Credential = new("credential", Name: "Svc ']' cred");
    private const string Modified = "2026-11-20T14:32:07.123";
    private const string Secret = "Pa'ss w0rd ]] -- secret";

    private sealed class Host(ServerProfile profile) : IActionHost
    {
        public ServerProfile Profile(string connectionId) => profile;
        public SqlConnection Connection(string connectionId) => new("Data Source=" + Unreachable.Source + ";Connect Timeout=1;Pooling=false;Encrypt=false");
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) => true;
        public bool FreeDatabase(string connectionId, string database) => true;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
        public IReadOnlyList<string> SameServer(string connectionId) => [connectionId];
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
    }

    private static ActionArgs Save(AgentProxySaveDto save, ObjectRefDto? target = null, int? proxyId = 5, string? secret = null) =>
        new("agentProxy", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target ?? Proxy)
        {
            AgentProxy = save, ProxyId = target?.Kind == "agent" ? null : proxyId, Secrets = secret is null ? null : new(Secret: secret)
        };
    private static ActionArgs CredentialSave(CredentialSaveDto save, ObjectRefDto? target = null, string? secret = Secret) =>
        new("credential", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target ?? Credential) { Credential = save, Secrets = secret is null ? null : new(Secret: secret) };
    private static ActionArgs Verb(string action, int? proxyId = 5) =>
        new(action, Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), Proxy)
        {
            ProxyId = proxyId, NewName = action == "rename" ? "Renamed" : null, CloseConnections = action == "delete" ? false : null, DeleteHistory = action == "delete" ? false : null
        };

    public static Task RunAsync(Action<bool, string> check)
    {
        Lint(check);
        Planner(check);
        Validation(check);
        Errors(check);
        Script(check);
        return Task.CompletedTask;
    }

    private static void Lint(Action<bool, string> check)
    {
        var saves = AgentSql.LintProxySaves().ToList();
        var failures = saves.Where(item => item.Problems.Count > 0).Select(item => item.Name + ": " + string.Join(", ", item.Problems)).ToList();
        check(failures.Count == 0 && saves.Count == 6, "the proxy batch's six shapes (New Proxy and its principals, update and its principals, rename, delete) pass their lint" + (failures.Count == 0 ? "" : ": " + string.Join("; ", failures)));
        check(AgentSql.LintWrites().Count(item => item.Name.StartsWith("proxy save ", StringComparison.Ordinal)) == 6, "the Agent write lint (and so the object actions' lint) runs the proxy batches too");
        var credential = CredentialSql.Lint().ToList();
        var credentialFailures = credential.Where(item => item.Problems.Count > 0).Select(item => item.Name + ": " + string.Join(", ", item.Problems)).ToList();
        check(credentialFailures.Count == 0 && credential.Count == 9, "every credential batch and the documents' five reads pass their lints" + (credentialFailures.Count == 0 ? "" : ": " + string.Join("; ", credentialFailures)));
        check(ActionSql.Lint().Count(item => item.Name.StartsWith("create credential", StringComparison.Ordinal) || item.Name.StartsWith("credential ", StringComparison.Ordinal)) == 7,
            "the object actions' lint runs the credential builder and the documents' reads");

        string Call(int index, string call) => call + AgentSql.CheckAt(index);
        var head = AgentSql.ProxyHead;
        var add = Call(1, "EXEC @rc = msdb.dbo.sp_add_proxy @proxy_name = @proxy_name, @credential_name = @credential_name, @proxy_id = @proxy_id OUTPUT;");
        var update = Call(1, "EXEC @rc = msdb.dbo.sp_update_proxy @proxy_id = @proxy_id, @enabled = @enabled;");
        var grant = Call(2, "EXEC @rc = msdb.dbo.sp_grant_proxy_to_subsystem @proxy_id = @proxy_id, @subsystem_id = @subsystem_id_2;");
        check(AgentSql.LintProxySave(head + add + grant).Count == 0 && AgentSql.LintProxySave(head + AgentSql.ProxyResolve + update + grant).Count == 0
            && AgentSql.LintProxySave(head + CredentialSql.ProxyBlock + add).Count == 0, "the proxy lint admits New Proxy with a grant, an update with a grant, and a credential block before an add");
        var misses = new (string Text, string Problem)[]
        {
            (AgentSql.ProxyResolve + update, "does not open with the proxy's declaration"),
            (head + "SELECT @proxy_id = p.proxy_id FROM msdb.dbo.sysproxies AS p;\n" + update, "resolves the proxy in another shape"),
            (head + "DECLARE @x int;\n" + add, "has a statement before its calls that is not exactly the credential block"),
            (head + CredentialSql.ProxyBlock.Replace("@secret COLLATE", "@identity COLLATE", StringComparison.Ordinal) + add, "has a statement before its calls that is not exactly the credential block"),
            (head + "EXEC @rc = msdb.dbo.sp_add_proxy @proxy_name = @proxy_name, @proxy_id = @proxy_id OUTPUT;" + AgentSql.CheckAt(2), "call 1 is not followed by its return-code check"),
            (head + Call(1, "EXEC @rc = msdb.dbo.sp_add_proxy @proxy_name = @proxy_name, @proxy_id = @proxy_id;"), "does not take the new proxy's id as sp_add_proxy's OUTPUT"),
            (head + add + Call(2, "EXEC @rc = msdb.dbo.sp_grant_proxy_to_subsystem @proxy_id = @proxy_id, @subsystem_id = @subsystem_id;"), "passes @subsystem_id another parameter's value"),
            (head + add + Call(2, "EXEC @rc = msdb.dbo.sp_grant_proxy_to_subsystem @proxy_id = @proxy_id, @subsystem_id = @subsystem_id_3;"), "passes @subsystem_id another parameter's value"),
            (head + add + Call(2, "EXEC @rc = msdb.dbo.sp_grant_proxy_to_subsystem @subsystem_id = @subsystem_id_2;"), "sp_grant_proxy_to_subsystem does not name the proxy by its id"),
            (head + add + Call(2, "EXEC @rc = msdb.dbo.sp_grant_login_to_proxy @proxy_id = @proxy_id, @login_name = @login_name_2, @msdb_role = @msdb_role_2;"), "names other than one subsystem or principal"),
            (head + add + Call(2, "EXEC @rc = msdb.dbo.sp_grant_proxy_to_subsystem @proxy_id = @proxy_id, @subsystem_id = 3;"), "call 2 is not one msdb call in the save shape"),
            (head + add + Call(2, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id;"), "EXECs sp_update_job, which a proxy save does not call"),
            (head + Call(1, "EXEC @rc = msdb.dbo.sp_add_proxy @proxy_name = @proxy_name, @output = @output, @proxy_id = @proxy_id OUTPUT;"), "passes @output to sp_add_proxy"),
            (head + grant.Replace("_2;", "_1;", StringComparison.Ordinal).Replace(AgentSql.CheckAt(2), AgentSql.CheckAt(1), StringComparison.Ordinal), "New Proxy's save does not add the proxy first, once"),
            (head + add + Call(2, "EXEC @rc = msdb.dbo.sp_revoke_login_from_proxy @proxy_id = @proxy_id, @name = @name_2;"), "New Proxy's save changes or revokes something"),
            (head + AgentSql.ProxyResolve + add, "adds a proxy in an existing proxy's save"),
            (head + AgentSql.ProxyResolve + Call(1, "EXEC @rc = msdb.dbo.sp_grant_proxy_to_subsystem @proxy_id = @proxy_id, @subsystem_id = @subsystem_id_1;")
                + Call(2, "EXEC @rc = msdb.dbo.sp_update_proxy @proxy_id = @proxy_id, @enabled = @enabled;"), "updates the proxy more than once, or after a grant"),
            (head + AgentSql.ProxyResolve + Call(1, "EXEC @rc = msdb.dbo.sp_delete_proxy @proxy_id = @proxy_id;") + grant, "deletes the proxy alongside other calls"),
            (head + AgentSql.ProxyResolve + CredentialSql.ProxyBlock + Call(1, "EXEC @rc = msdb.dbo.sp_delete_proxy @proxy_id = @proxy_id;"), "creates a credential without adding or updating the proxy"),
            (head + AgentSql.ProxyResolve + Call(1, "EXEC @rc = master.dbo.xp_servicecontrol @a = @a;"), "uses xp_servicecontrol"),
            (head + AgentSql.ProxyResolve, "makes no call"),
            (head + AgentSql.ProxyResolve + update + Call(2, "EXEC @rc = msdb.dbo.sp_grant_login_to_proxy @proxy_id = @proxy_id, @login_name = @login_name_2;"), "grants or revokes a principal alongside other calls"),
            (head + AgentSql.ProxyResolveByName + CredentialSql.ProxyBlock + Call(1, "EXEC @rc = msdb.dbo.sp_grant_login_to_proxy @proxy_id = @proxy_id, @login_name = @login_name_1;"), "creates a credential in the principals' batch")
        };
        foreach (var (text, problem) in misses)
        {
            var found = AgentSql.LintProxySave(text);
            var refused = found.Any(item => item.EndsWith(problem, StringComparison.Ordinal));
            check(refused, "the proxy lint refuses a batch that " + problem + (refused ? "" : " (found: " + string.Join(", ", found) + ")"));
        }

        var create = CredentialSql.Executable(true, false);
        var credentialMisses = new (string Text, string Problem)[]
        {
            (create.Replace(CredentialSql.IdentityGuard, "", StringComparison.Ordinal), "does not check @identity and @secret for NULL first"),
            (create.Replace(" COLLATE Latin1_General_BIN2, N'''', N'''''') + N''''", ", N'''', N'''''') + N''''", StringComparison.Ordinal), "does not quote @identity and @secret exactly once through the binary-collation REPLACE"),
            (create.Replace("EXEC @module @stmt;", "SELECT @secret AS s;\nEXEC @module @stmt;", StringComparison.Ordinal), "uses @secret 3 times"),
            (create.Replace("QUOTENAME(@p1)", "@p1", StringComparison.Ordinal), "uses @p1 outside QUOTENAME and its guards"),
            (create.Replace(ActionSql.Guard, "", StringComparison.Ordinal), "has no quoting guard"),
            (create.Replace("EXEC @module @stmt;", "EXEC @module @stmt;\nEXEC @module @stmt;", StringComparison.Ordinal), "does not run exactly one EXEC @module @stmt"),
            (create.Replace("N'CREATE CREDENTIAL '", "N'DROP CREDENTIAL '", StringComparison.Ordinal), "has the literal N'DROP CREDENTIAL '"),
            (create.Replace("N'CREATE CREDENTIAL '", "N'CREATE CREDENTIAL {0}'", StringComparison.Ordinal), "has a format hole"),
            (create + "\nPRINT @stmt;", "has a banned word: PRINT"),
            (CredentialSql.Executable(false, false) + CredentialSql.StaleGuard, "guards the credential more than once")
        };
        foreach (var (text, problem) in credentialMisses)
        {
            var found = CredentialSql.LintExecutable(text);
            var refused = found.Any(item => item.StartsWith(problem, StringComparison.Ordinal));
            check(refused, "the credential lint refuses a batch that " + problem + (refused ? "" : " (found: " + string.Join(", ", found) + ")"));
        }
        check(CredentialSql.Executable(false, false).Contains(CredentialSql.StaleGuard, StringComparison.Ordinal) && CredentialSql.StaleGuard.Contains("c.modify_date = @modified", StringComparison.Ordinal)
            && CredentialSql.StaleGuard.Contains("THROW 50011", StringComparison.Ordinal) && !CredentialSql.Executable(true, false).Contains("THROW 50011", StringComparison.Ordinal),
            "an existing credential's ALTER runs behind the STALE guard (its id, name and modify_date as read); New Credential's has none");
        check(CredentialSql.Statement(true, false).Contains("CONVERT(nvarchar(max), N'CREATE CREDENTIAL ')", StringComparison.Ordinal)
            && AgentSql.IdentityParameter.Size == -1 && AgentSql.SecretParameter.Size == -1,
            "the statement is built as nvarchar(max) from its first operand, and the identity and secret are nvarchar(max), so a 4,000-character secret with doubled quotes is never cut");
    }

    private static void Planner(Action<bool, string> check)
    {
        static string Names(AgentSaveCall call) => string.Join(",", call.Arguments.Select(argument => argument.Parameter.Name));
        static object? ValueOf(AgentSaveBatch batch, string name) => batch.Parameters.First(parameter => parameter.Parameter.Name == name).Value;

        var plan = ActionService.AgentProxySavePlan(Save(new(Name: "New", Enabled: false, Description: "d", NewCredential: new("Cred", "DOMAIN\\svc"), GrantSubsystems: [3, 12],
            GrantPrincipals: [new("bob", "login"), new("SQLAgentOperatorRole", "msdbRole"), new("securityadmin", "serverRole")]), AgentNode, secret: Secret), AgentNode);
        var created = plan.Main!;
        var granted = plan.Principals!;
        check(created.Calls.Select(call => call.Procedure).SequenceEqual(["sp_add_proxy", "sp_grant_proxy_to_subsystem", "sp_grant_proxy_to_subsystem"])
            && Names(created.Calls[0]) == "@proxy_name,@enabled,@description,@credential_name,@proxy_id" && created.Calls[0].Arguments[^1].Output
            && Names(created.Calls[1]) == "@proxy_id,@subsystem_id_2" && Names(created.Calls[2]) == "@proxy_id,@subsystem_id_3"
            && AgentSql.LintProxySave(created.Text).Count == 0 && created.Text.Contains(CredentialSql.ProxyBlock, StringComparison.Ordinal)
            && (string?)ValueOf(created, "@credential_name") == "Cred" && (string?)ValueOf(created, "@p1") == "Cred" && (string?)ValueOf(created, "@secret") == Secret && (string?)ValueOf(created, "@db") == "master",
            "New Proxy's save creates its credential first, adds the proxy as it (the new id an OUTPUT), then grants each subsystem on its own indexed parameter");
        check(granted.Calls.All(call => call.Procedure == "sp_grant_login_to_proxy") && granted.Calls.Count == 3
            && granted.Calls[0].Arguments[1].Name == "@login_name" && granted.Calls[1].Arguments[1].Name == "@msdb_role" && granted.Calls[2].Arguments[1].Name == "@fixed_server_role"
            && Names(granted.Calls[0]) == "@proxy_id,@login_name_1" && granted.Text.StartsWith(AgentSql.ProxyHead + AgentSql.ProxyResolveByName, StringComparison.Ordinal)
            && (string?)ValueOf(granted, "@name") == "New" && !granted.Text.Contains(CredentialSql.ProxyBlock, StringComparison.Ordinal) && AgentSql.LintProxySave(granted.Text).Count == 0
            && ActionService.Calls(plan).Count() == 6,
            "New Proxy's principal grants are a second batch of their own (msdb's principal check dooms a transaction), resolving the new proxy by its name");
        check(!created.Text.Contains(Secret, StringComparison.Ordinal) && !created.Text.Contains("DOMAIN", StringComparison.Ordinal) && !created.Text.Contains("Cred", StringComparison.Ordinal)
            && granted.Parameters.All(parameter => !Equals(parameter.Value, Secret)),
            "the batch text holds no value: the secret, identity and names travel only as parameters, and the principals' batch never carries the secret");
        var existingPlan = ActionService.AgentProxySavePlan(Save(new(Name: "Renamed", Credential: "Other", RevokeSubsystems: [3], RevokePrincipals: ["bob"])), Proxy);
        var existing = existingPlan.Main!;
        var revoked = existingPlan.Principals!;
        check(existing.Calls.Select(call => call.Procedure).SequenceEqual(["sp_update_proxy", "sp_revoke_proxy_from_subsystem"])
            && Names(existing.Calls[0]) == "@proxy_id,@credential_name,@new_name" && AgentSql.LintProxySave(existing.Text).Count == 0
            && existing.Text.StartsWith(AgentSql.ProxyHead + AgentSql.ProxyResolve, StringComparison.Ordinal) && (string?)ValueOf(existing, "@name") == Proxy.Name && (int?)ValueOf(existing, "@expected_proxy_id") == 5
            && !existing.Text.Contains(CredentialSql.ProxyBlock, StringComparison.Ordinal),
            "an existing proxy's save resolves it by name and the id it read and updates only what changed");
        check(revoked.Calls is [{ Procedure: "sp_revoke_login_from_proxy" }] && Names(revoked.Calls[0]) == "@proxy_id,@name_1" && AgentSql.LintProxySave(revoked.Text).Count == 0
            && revoked.Text.StartsWith(AgentSql.ProxyHead + AgentSql.ProxyResolve, StringComparison.Ordinal) && (string?)ValueOf(revoked, "@name") == "Renamed" && (int?)ValueOf(revoked, "@expected_proxy_id") == 5,
            "an existing proxy's principal revokes follow by its saved name and the id it read, and revoke by name");
        var grantsOnly = ActionService.AgentProxySavePlan(Save(new(GrantSubsystems: [11])), Proxy);
        check(grantsOnly.Main!.Calls is [{ Procedure: "sp_grant_proxy_to_subsystem" }] && Names(grantsOnly.Main.Calls[0]) == "@proxy_id,@subsystem_id_1" && AgentSql.LintProxySave(grantsOnly.Main.Text).Count == 0
            && grantsOnly.Principals is null,
            "a save that only grants makes no sp_update_proxy and no principals' batch");
        var principalsOnly = ActionService.AgentProxySavePlan(Save(new(GrantPrincipals: [new("bob", "login")])), Proxy);
        check(principalsOnly.Main is null && principalsOnly.Principals!.Calls is [{ Procedure: "sp_grant_login_to_proxy" }] && (string?)ValueOf(principalsOnly.Principals, "@name") == Proxy.Name,
            "a save that only grants principals makes only the principals' batch, by the proxy's own name");
        var renamed = ActionService.AgentProxyVerbPlan(Verb("rename", null), Proxy);
        var renamedById = ActionService.AgentProxyVerbPlan(Verb("rename"), Proxy);
        var deleted = ActionService.AgentProxyVerbPlan(Verb("delete"), Proxy);
        check(renamed.Text.StartsWith(AgentSql.ProxyHead + AgentSql.ProxyResolveByName, StringComparison.Ordinal) && renamedById.Text.StartsWith(AgentSql.ProxyHead + AgentSql.ProxyResolve, StringComparison.Ordinal)
            && renamed.Calls is [{ Procedure: "sp_update_proxy" }] && (string?)ValueOf(renamed, "@new_name") == "Renamed"
            && deleted.Calls is [{ Procedure: "sp_delete_proxy" }] && deleted.Text.StartsWith(AgentSql.ProxyHead + AgentSql.ProxyResolve, StringComparison.Ordinal)
            && new[] { renamed, renamedById, deleted }.All(batch => AgentSql.LintProxySave(batch.Text).Count == 0),
            "Rename resolves the proxy by name (Object Explorer's row has no id) or by its id when read; Delete by the id Delete Object read");

        var credential = ActionService.CredentialParameters(CredentialSave(new("DOMAIN\\svc", Id: 9, Modified: Modified)), Credential);
        check((string?)credential.First(item => item.Parameter.Name == "@p1").Value == Credential.Name && (int?)credential.First(item => item.Parameter.Name == "@credential_id").Value == 9
            && credential.First(item => item.Parameter.Name == "@modified").Value is DateTime modified && modified == new DateTime(2026, 11, 20, 14, 32, 7, 123)
            && (string?)credential.First(item => item.Parameter.Name == "@secret").Value == Secret && credential.All(item => item.Parameter.Name != "@p2"),
            "an existing credential's ALTER binds its name, the id and modify_date it read, the identity and the secret");
        var newCredential = ActionService.CredentialParameters(CredentialSave(new("id", Name: "New", Provider: "Ekm"), Server), Server);
        check((string?)newCredential.First(item => item.Parameter.Name == "@p1").Value == "New" && (string?)newCredential.First(item => item.Parameter.Name == "@p2").Value == "Ekm"
            && newCredential.All(item => item.Parameter.Name is not ("@credential_id" or "@modified")), "New Credential binds its name and provider and no STALE guard");
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(Box2022));
        string Answer(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var longName = new string('n', 128);
        var valid = new (string Name, ActionArgs Args)[]
        {
            ("a description", Save(new(Description: "x"))), ("a rename", Save(new(Name: longName))), ("a credential change", Save(new(Credential: "c"))),
            ("grants and revokes", Save(new(GrantSubsystems: [3], RevokeSubsystems: [4], GrantPrincipals: [new("bob", "login")], RevokePrincipals: ["amy"]))),
            ("New Proxy", Save(new(Name: "New", Credential: "c"), AgentNode)), ("New Proxy with a subsystem", Save(new(Name: "New", Credential: "c", GrantSubsystems: [3]), AgentNode)),
            ("Rename", Verb("rename")), ("Rename by name", Verb("rename", null)), ("Delete", Verb("delete")),
            ("New Credential", CredentialSave(new("DOMAIN\\svc", Name: "c"), Server)), ("New Credential with a provider", CredentialSave(new("id", Name: "c", Provider: "Ekm"), Server)),
            ("an existing credential's ALTER", CredentialSave(new("DOMAIN\\svc", Id: 1, Modified: Modified))),
            ("a 128-character identity and a 4,000-character secret", CredentialSave(new(new string('i', 128), Id: 1, Modified: Modified), secret: new string('s', 4000)))
        };
        foreach (var (name, args) in valid) check(Answer(args) == "accepted" && Answer(args with { Secrets = null }, script: true) == "accepted", "the proxy and credential requests validate: " + name);
        check(Answer(Save(new(Name: "New", NewCredential: new("c", "DOMAIN\\svc")), AgentNode, secret: Secret)) == "accepted"
            && Answer(Save(new(Name: "New", NewCredential: new("c", "DOMAIN\\svc")), AgentNode, secret: Secret), script: true) == "INVALID_PARAMS"
            && Answer(Save(new(Name: "New", NewCredential: new("c", "DOMAIN\\svc")), AgentNode), script: true) == "accepted",
            "a new credential's secret goes on execute, and never on Script");
        check(Answer(Save(new(Description: "x"), proxyId: null), script: true) == "accepted" && Answer(Save(new(Description: "x"), proxyId: null)) == "INVALID_PARAMS"
            && Answer(Verb("delete", null), script: true) == "accepted" && Answer(Verb("delete", null)) == "INVALID_PARAMS",
            "Script may leave out the proxy's id; a save and a Delete may not");
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("nothing to change", Save(new())), ("a blank name", Save(new(Name: ""))), ("a 129-character name", Save(new(Name: longName + "n"))), ("a name with U+0000", Save(new(Name: "a\0b"))),
            ("a 513-character description", Save(new(Description: new string('d', 513)))), ("two credentials", Save(new(Credential: "a", NewCredential: new("b", "i")), secret: Secret)),
            ("a new credential without its secret", Save(new(NewCredential: new("b", "i")))), ("a secret without a new credential", Save(new(Description: "x"), secret: Secret)),
            ("a new credential with a blank identity", Save(new(NewCredential: new("b", "")), secret: Secret)), ("a blank secret", Save(new(NewCredential: new("b", "i")), secret: "")),
            ("a 4,001-character secret", Save(new(NewCredential: new("b", "i")), secret: new string('s', 4001))), ("a 129-character identity", Save(new(NewCredential: new("b", new string('i', 129))), secret: Secret)), ("a secret with U+0000", Save(new(NewCredential: new("b", "i")), secret: "a\0b")),
            ("a secret with an unpaired surrogate", Save(new(NewCredential: new("b", "i")), secret: "a\uD800b")),
            ("a password in place of the secret", Save(new(NewCredential: new("b", "i"))) with { Secrets = new(Password: "p") }),
            ("a subsystem granted and revoked", Save(new(GrantSubsystems: [3], RevokeSubsystems: [3]))), ("a subsystem id of 0", Save(new(GrantSubsystems: [0]))),
            ("no subsystems listed", Save(new(GrantSubsystems: []))), ("too many subsystems", Save(new(GrantSubsystems: [.. Enumerable.Range(1, 33)]))),
            ("a principal granted and revoked", Save(new(GrantPrincipals: [new("Bob", "login")], RevokePrincipals: ["bob"]))), ("an unknown principal kind", Save(new(GrantPrincipals: [new("bob", "user")]))),
            ("too many principals", Save(new(RevokePrincipals: [.. Enumerable.Range(1, 65).Select(index => "p" + index)]))),
            ("New Proxy without a credential", Save(new(Name: "New"), AgentNode)), ("New Proxy without a name", Save(new(Credential: "c"), AgentNode)),
            ("New Proxy revoking", Save(new(Name: "New", Credential: "c", RevokeSubsystems: [3]), AgentNode)), ("New Proxy with an id", Save(new(Name: "New", Credential: "c"), AgentNode) with { ProxyId = 3 }),
            ("a proxy id of 0", Save(new(Description: "x"), proxyId: 0)), ("a database's target", Save(new(Description: "x"), new ObjectRefDto("database", Name: "db"))),
            ("another member", Save(new(Description: "x")) with { NewName = "x" }), ("the save on another action", Verb("rename") with { AgentProxy = new(Name: "y") }),
            ("a proxy id on a job", new ActionArgs("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new ObjectRefDto("agentJob", Name: "j")) { NewName = "k", AgentIdentity = new("00000000-1111-2222-3333-444444444441"), ProxyId = 1 }),
            ("Rename to the same name", Verb("rename") with { NewName = Proxy.Name }), ("Delete closing connections", Verb("delete") with { CloseConnections = true }),
            ("Disable on a proxy", Verb("rename") with { Action = "disable", NewName = null }), ("a secret on Rename", Verb("rename") with { Secrets = new(Secret: Secret) }),
            ("a credential without its secret", CredentialSave(new("i", Id: 1, Modified: Modified), secret: null)), ("a credential with a blank identity", CredentialSave(new("", Id: 1, Modified: Modified))),
            ("a 4,001-character identity", CredentialSave(new(new string('i', 4001), Id: 1, Modified: Modified))), ("an ALTER without its modified date", CredentialSave(new("i", Id: 1))),
            ("an ALTER renaming", CredentialSave(new("i", Id: 1, Modified: Modified, Name: "x"))), ("an ALTER changing the provider", CredentialSave(new("i", Id: 1, Modified: Modified, Provider: "p"))),
            ("New Credential without a name", CredentialSave(new("i"), Server)), ("New Credential with an id", CredentialSave(new("i", Id: 1, Name: "c"), Server)),
            ("a secret on New Login's request", new ActionArgs("unlock", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new ObjectRefDto("login", Name: "l")) { Secrets = new(Secret: Secret) })
        };
        foreach (var (name, args) in invalid) check(Answer(args) == "INVALID_PARAMS", "the proxy and credential requests are refused: " + name);
        string Describe(string dialog, ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), dialog, target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Describe("agentProxy", Proxy) == "accepted" && Describe("agentProxy", AgentNode) == "accepted" && Describe("agentProxy", Server) == "INVALID_PARAMS"
            && Describe("credential", Credential) == "accepted" && Describe("credential", Server) == "accepted" && Describe("credential", AgentNode) == "INVALID_PARAMS"
            && Describe("deleteObject", Proxy) == "accepted" && Describe("agentProxy", new ObjectRefDto("agent", Name: "x")) == "INVALID_PARAMS",
            "the proxy document describes a proxy or the Agent node, the credential document a credential or the server, and Delete Object a proxy");
        check(new LoginSecretsDto(Secret: Secret).ToString() is var printed && !printed.Contains(Secret, StringComparison.Ordinal) && printed.Contains("Secret = <redacted>", StringComparison.Ordinal),
            "a request's secrets print redacted, the credential's secret too");
    }

    private static SqlException Exception(params (int Number, byte State, string Message)[] errors)
    {
        var collection = (SqlErrorCollection)Activator.CreateInstance(typeof(SqlErrorCollection), true)!;
        var add = typeof(SqlErrorCollection).GetMethod("Add", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        foreach (var (number, state, message) in errors)
        {
            var constructor = typeof(SqlError).GetConstructors(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
                .First(candidate => candidate.GetParameters().Length >= 8);
            var values = constructor.GetParameters().Select(parameter => parameter.Name switch
            {
                "infoNumber" => (object)number, "errorState" => state, "errorClass" => (byte)16, "server" => "s", "errorMessage" => message, "procedure" => "p", "lineNumber" => 1,
                _ => parameter.ParameterType == typeof(uint) ? 0u : parameter.ParameterType == typeof(int) ? 0 : parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType) : null
            }).ToArray();
            add.Invoke(collection, [constructor.Invoke(values)]);
        }
        var create = typeof(SqlException).GetMethod("CreateException", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic, [typeof(SqlErrorCollection), typeof(string)])!;
        return (SqlException)create.Invoke(null, [collection, "16.0"])!;
    }

    private static void Errors(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(Box2022));
        var saved = ActionService.AgentProxySavePlan(Save(new(Description: "d", GrantSubsystems: [3], GrantPrincipals: [new("bob", "login")])), Proxy);
        var batch = saved.Main!;
        check(service.ProxySaveError(Exception((50010, 1, AgentSql.ProxyChangedMessage)), batch, null, false, false, null) is { Code: "NOT_FOUND" }, "the proxy identity guard's 50010 is NOT_FOUND");
        var subsystem = service.ProxySaveError(Exception((14262, 2, "The specified @subsystem_id ('3') does not exist."), (50012, 2, AgentSql.RefusedMessage)), batch, null, false, false, null);
        check(subsystem is { Field: "subsystems" } && subsystem.Message.StartsWith("Granting a subsystem was refused: ", StringComparison.Ordinal),
            "a refused subsystem grant names its part and the Subsystems field");
        var principal = service.ProxySaveError(Exception((14523, 3, "\"bob\" has not been granted permission to use proxy."), (50012, 1, AgentSql.RefusedMessage)), saved.Principals!, null, false, false, null);
        check(principal is { Field: "principals" } && principal.Message.StartsWith("Granting 'bob' the proxy was refused", StringComparison.Ordinal), "a refused principal grant names the principal and the Principals field");
        var renamed = ActionService.AgentProxySavePlan(Save(new(Name: "Taken")), Proxy).Main!;
        check(service.ProxySaveError(Exception((14261, 1, "The specified @name ('Taken') already exists."), (50012, 1, AgentSql.RefusedMessage)), renamed, null, false, false, null) is { Code: "NAME_IN_USE", Field: "name" },
            "a taken name is NAME_IN_USE on the name field");
        var credential = service.ProxySaveError(Exception((15530, 1, "The credential with name \"Cred\" already exists.")), batch, null, false, true, Secret);
        check(credential is { Code: "NAME_IN_USE", Field: "credential" } && credential.Message.StartsWith("Creating the credential was refused: ", StringComparison.Ordinal),
            "a CREATE CREDENTIAL that aborts the batch before any call is the credential field's refusal");
        var leaked = service.ProxySaveError(Exception((102, 1, "Incorrect syntax near '" + Secret.Replace("'", "''", StringComparison.Ordinal) + "'.")), batch, null, false, true, Secret);
        check(!leaked.Message.Contains(Secret, StringComparison.Ordinal) && !leaked.Message.Contains(Secret.Replace("'", "''", StringComparison.Ordinal), StringComparison.Ordinal) && leaked.Message.Contains(CredentialSql.Placeholder, StringComparison.Ordinal),
            "a refusal that quotes the secret is scrubbed");
        check(service.CredentialSaveError(Exception((50011, 1, AgentSql.StaleMessage)), null, Secret) is { Code: "STALE" }, "an ALTER whose credential changed since is STALE");
        var credentialLeak = service.CredentialSaveError(Exception((15530, 1, "The credential with name \"x" + Secret + "\" already exists.")), null, Secret);
        check(credentialLeak is { Code: "NAME_IN_USE", Field: "name" } && !credentialLeak.Message.Contains(Secret, StringComparison.Ordinal), "a taken credential name is NAME_IN_USE on the name field, its text scrubbed");
        check(CredentialSql.Scrub("x '" + Secret + "' y " + Secret, Secret) == "x '<secret>' y <secret>" && CredentialSql.Scrub("short 'ab' ab", "ab") == "short '<secret>' ab",
            "the scrubber replaces the secret quoted, and bare from eight characters");
    }

    private static void Script(Action<bool, string> check)
    {
        var created = ActionService.AgentProxyScript(Save(new(Name: "New", NewCredential: new("Cred", "DOMAIN\\o'svc"), GrantSubsystems: [3], GrantPrincipals: [new("bob", "login")]), AgentNode), AgentNode);
        check(created == "USE [master]\nGO\nCREATE CREDENTIAL [Cred] WITH IDENTITY = N'DOMAIN\\o''svc', SECRET = <secret>\nGO\nUSE [msdb]\nGO\n"
            + "EXEC msdb.dbo.sp_add_proxy @proxy_name=N'New', @credential_name=N'Cred'\nGO\n"
            + "EXEC msdb.dbo.sp_grant_proxy_to_subsystem @proxy_name=N'New', @subsystem_id=3\nGO\n"
            + "EXEC msdb.dbo.sp_grant_login_to_proxy @proxy_name=N'New', @login_name=N'bob'\nGO\n",
            "New Proxy's script creates its credential with <secret>, then adds and grants the proxy by name" + "\n" + created);
        var renamed = ActionService.AgentProxyScript(Save(new(Name: "B", GrantSubsystems: [3])), Proxy);
        check(renamed == "USE [msdb]\nGO\nEXEC msdb.dbo.sp_update_proxy @proxy_name=N'Run '']'' -- as', @new_name=N'B'\nGO\nEXEC msdb.dbo.sp_grant_proxy_to_subsystem @proxy_name=N'B', @subsystem_id=3\nGO\n",
            "an existing proxy's script names it by name, and by its new name after a rename");
        check(ActionService.AgentProxyScript(Verb("delete", null), Proxy) == "USE [msdb]\nGO\nEXEC msdb.dbo.sp_delete_proxy @proxy_name=N'Run '']'' -- as'\nGO\n", "Delete's script is sp_delete_proxy by name");
        check(ActionService.CredentialScript(CredentialSave(new("DOMAIN\\svc", Name: "C]", Provider: "Ekm"), Server, null), Server)
                == "USE [master]\nGO\nCREATE CREDENTIAL [C]]] WITH IDENTITY = N'DOMAIN\\svc', SECRET = <secret> FOR CRYPTOGRAPHIC PROVIDER [Ekm]\nGO\n"
            && ActionService.CredentialScript(CredentialSave(new("id", Id: 1, Modified: Modified), null, null), Credential) == "USE [master]\nGO\nALTER CREDENTIAL [Svc ']]' cred] WITH IDENTITY = N'id', SECRET = <secret>\nGO\n",
            "a credential's script writes CREATE or ALTER CREDENTIAL with <secret>");
    }
}
