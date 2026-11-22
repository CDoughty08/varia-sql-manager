using System.Text.Json;
using Varia.Backend.Actions;

namespace Varia.Backend.Tests;

/// <summary>Live checks of the proxy and Credential documents (AG-8b), part of the Agent suite with VARIA_TEST_SQL_SCRATCH=1, on this run's
/// scratch proxy (<c>_px</c>) and credential (<c>_cr</c>), dropped in finally: New Proxy with its credential created in place and an msdb role, a
/// fixed server role and a subsystem granted in the one save (msdb's principal check would doom a transaction; the principals' batch runs after
/// it commits); the describe reading it back; an update that renames it and revokes the principals; a save under the wrong id refused before any
/// call; Script writing &lt;secret&gt;; the credential's document with Used by, and its ALTER with a 4,000-character secret of quotes behind the
/// STALE guard; a taken credential name refused on the name field with the secret scrubbed; and Delete by the id Delete Object read. A Windows
/// server only: the credential's identity is SQL Server Agent's own service account, which sp_add_proxy can resolve.</summary>
internal static class AgentProxyLiveChecks
{
    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        Task<ActionDescribeResult> Describe(string dialog, ObjectRefDto target) => Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), dialog, target));
        Task<ActionExecuteResult> Execute(ActionArgs args) => Call<ActionExecuteResult>("actions.execute", args with { ConnectionId = info.Id, RequestId = Guid.NewGuid().ToString() });
        Task<ActionScriptResult> Script(ActionArgs args) => Call<ActionScriptResult>("actions.script", args with { ConnectionId = info.Id, RequestId = Guid.NewGuid().ToString() });
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title)) + (result.Error is { } error ? " " + error.Code + " " + error.Field + " " + error.Message : "");

        var platform = await sql("SELECT host_platform FROM sys.dm_os_host_info;", "master");
        var account = await sql("SELECT TOP (1) service_account FROM sys.dm_server_services WHERE servicename LIKE N'SQL Server Agent%';", "master");
        if (platform.Scalar != "Windows" || string.IsNullOrEmpty(account.Scalar) || !account.Scalar.Contains('\\', StringComparison.Ordinal))
        {
            Console.WriteLine("Proxy and credential live checks skipped: they need a Windows server whose SQL Server Agent runs as a Windows account.");
            return;
        }
        var identity = account.Scalar;
        var proxy = scratch.AgentObject("px");
        var credential = scratch.AgentObject("cr");
        var renamed = proxy + "2";
        // Quotes and brackets in the secret: the backend doubles them on the server, so nothing is cut or injected.
        var secret = "o'clock ]] " + ScratchDatabase.Throwaway();
        var agent = new ObjectRefDto("agent");
        try
        {
            var blank = await Describe("agentProxy", agent);
            var cmdExec = blank.AgentProxyDocument?.Subsystems.FirstOrDefault(item => item.Name == "CmdExec")?.Id;
            check(blank is { Error: null, AgentProxyDocument: { Proxy: null, CanCreateCredential: true } model } && cmdExec is not null && model.Subsystems.All(item => item.Name != "TSQL"),
                "as sysadmin, New Proxy describes the subsystems (all but T-SQL) and offers a credential created in place: " + blank.Error?.Message);
            if (cmdExec is not { } subsystem) return;

            var save = new AgentProxySaveDto(Name: proxy, Description: "varia.scratch", NewCredential: new(credential, identity), GrantSubsystems: [subsystem],
                GrantPrincipals: [new("SQLAgentOperatorRole", "msdbRole"), new("securityadmin", "serverRole")]);
            var created = await Execute(new ActionArgs("agentProxy", "", "", agent) { AgentProxy = save, Secrets = new(Secret: secret) });
            check(created.Error is null && created.Steps is [{ Status: "done", Title: ActionService.CreateProxyStep }, { Status: "done", Title: ActionService.ProxyPrincipalsStep }]
                && created.Messages.All(message => !message.Contains(secret, StringComparison.Ordinal)),
                "New Proxy creates its credential, the proxy and its subsystem in one transaction, then grants an msdb role and a server role after it commits: " + Steps(created));

            var read = await Describe("agentProxy", new ObjectRefDto("agentProxy", Name: proxy));
            var record = read.AgentProxyDocument?.Proxy;
            check(record is { Description: "varia.scratch", Enabled: true } && record.Credential == credential && record.CredentialIdentity == identity && record.Subsystems.SequenceEqual([subsystem])
                && record.Principals.Select(item => item.Kind + ":" + item.Name).Order(StringComparer.Ordinal).SequenceEqual(["msdbRole:SQLAgentOperatorRole", "serverRole:securityadmin"])
                && read.AgentProxyDocument!.References is [] && read.AgentProxyDocument.Credentials.Any(item => item.Name == credential && item.Identity == identity),
                "the proxy's describe reads back its credential and identity, subsystem, principals by kind and no references: " + JsonSerializer.Serialize(record));
            if (record is null) return;

            var wrong = await Execute(new ActionArgs("agentProxy", "", "", new ObjectRefDto("agentProxy", Name: proxy)) { AgentProxy = new(Description: "x"), ProxyId = record.Id + 100_000 });
            check(wrong.Error is { Code: "NOT_FOUND" } && (await Describe("agentProxy", new ObjectRefDto("agentProxy", Name: proxy))).AgentProxyDocument?.Proxy?.Description == "varia.scratch",
                "a save under an id the proxy does not have is NOT_FOUND and changes nothing: " + Steps(wrong));

            var updated = await Execute(new ActionArgs("agentProxy", "", "", new ObjectRefDto("agentProxy", Name: proxy))
                { AgentProxy = new(Name: renamed, Enabled: false, RevokePrincipals: ["SQLAgentOperatorRole", "securityadmin"]), ProxyId = record.Id });
            var after = (await Describe("agentProxy", new ObjectRefDto("agentProxy", Name: renamed))).AgentProxyDocument?.Proxy;
            check(updated.Error is null && updated.Steps.Count == 2 && after is { Enabled: false, Principals: [] } && after.Id == record.Id,
                "an update renames and disables the proxy, then revokes its principals by the new name and the id it read: " + Steps(updated));

            var scripted = await Script(new ActionArgs("agentProxy", "", "", agent) { AgentProxy = save with { Name = proxy + "3", NewCredential = new(credential + "3", identity) } });
            check(scripted.Error is null && scripted.Text is { } text && text.Contains("SECRET = " + CredentialSql.Placeholder, StringComparison.Ordinal) && !text.Contains(secret, StringComparison.Ordinal)
                && text.Contains("sp_grant_login_to_proxy", StringComparison.Ordinal),
                "Script writes CREATE CREDENTIAL with <secret>, then the msdb calls by name: " + scripted.Error?.Message);

            var document = await Describe("credential", new ObjectRefDto("credential", Name: credential));
            var held = document.CredentialDocument?.Credential;
            check(document is { Error: null, CredentialDocument: { ReadOnly: null, UsedBy: [{ Proxy: var user }] } } && user == renamed && held?.Identity == identity && held.Modified.Length == 23,
                "the credential's document reads its identity and modify date, editable, with the proxy that uses it: " + JsonSerializer.Serialize(document.CredentialDocument));
            if (held is null) return;

            var quotes = new string('\'', 4000);
            var target = new ObjectRefDto("credential", Name: credential);
            var altered = await Execute(new ActionArgs("credential", "", "", target) { Credential = new(identity, Id: held.Id, Modified: held.Modified), Secrets = new(Secret: quotes) });
            var stale = await Execute(new ActionArgs("credential", "", "", target) { Credential = new(identity, Id: held.Id, Modified: held.Modified), Secrets = new(Secret: secret) });
            check(altered.Error is null && altered.Steps is [{ Status: "done" }] && stale.Error is { Code: "STALE" },
                "ALTER CREDENTIAL takes a 4,000-character secret of quotes whole, and a second save with the modify date read before it is STALE: " + Steps(altered) + " | " + Steps(stale));

            var taken = await Execute(new ActionArgs("credential", "", "", new ObjectRefDto("server")) { Credential = new(identity, Name: credential), Secrets = new(Secret: secret) });
            check(taken.Error is { Code: "NAME_IN_USE", Field: "name" } error && !error.Message.Contains(secret, StringComparison.Ordinal),
                "New Credential under a taken name is NAME_IN_USE on the name field, its text free of the secret: " + Steps(taken));

            var proxyTarget = new ObjectRefDto("agentProxy", Name: renamed);
            var deletion = await Describe("deleteObject", proxyTarget);
            var deleted = await Execute(new ActionArgs("delete", "", "", proxyTarget) { CloseConnections = false, DeleteHistory = false, ProxyId = deletion.DeleteTarget?.ProxyId });
            var gone = await sql("SELECT COUNT(*) FROM msdb.dbo.sysproxies WHERE name = " + Quote(renamed) + ";", "msdb");
            check(deletion.DeleteTarget?.ProxyId == record.Id && deleted.Error is null && gone.Scalar == "0", "Delete Object reads the proxy's id and deletes it by that id: " + Steps(deleted));
        }
        finally
        {
            await sql("DECLARE @name sysname; SELECT @name = name FROM msdb.dbo.sysproxies WHERE name IN (" + Quote(proxy) + ", " + Quote(renamed) + ");\n"
                + "IF @name IS NOT NULL EXEC msdb.dbo.sp_delete_proxy @proxy_name = @name;", "msdb");
            await sql("IF EXISTS (SELECT 1 FROM sys.credentials WHERE name = " + Quote(credential) + ") DROP CREDENTIAL [" + credential + "];", "master");
        }
    }
}
