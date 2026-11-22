using System.Data;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Varia.Backend.Actions;

namespace Varia.Backend.Agent;

/// <summary>How a proxy batch finds its proxy: New Proxy's makes it (sp_add_proxy's OUTPUT); an existing proxy's resolves it by name and
/// the proxy_id the document or Delete Object read (50010 when another proxy has taken the name since); Rename from Object Explorer, whose row
/// carries no id, by name alone.</summary>
internal enum ProxyResolution { Create, Identity, Name }

/// <summary>A proxy save's batches: <see cref="Main"/> in a transaction, then <see cref="Principals"/> (the principal grants and revokes) without
/// one; either is null when it makes no call.</summary>
internal sealed record ProxySavePlan(AgentSaveBatch? Main, AgentSaveBatch? Principals);

/// <summary>SQL Server Agent proxies' writes (AG-8b): the proxy document's Save, Rename and Delete, each one batch in one transaction (the
/// action's XACT_ABORT prologue and a SqlTransaction), except the save's principal grants and revokes, a second batch of their own with no
/// transaction (msdb's principal check dooms one). It opens with <see cref="ProxyHead"/>, then an existing proxy's resolve, then, when the
/// save creates its credential, <see cref="CredentialSql.ProxyBlock"/> (CREATE CREDENTIAL built on the server); then the msdb calls, each
/// followed by <see cref="CheckAt"/> whose THROW state is the call's index: sp_add_proxy (the new id as its OUTPUT) or sp_update_proxy or
/// sp_delete_proxy, then the subsystem grants and revokes and the principal grants and revokes, each bound to its own indexed parameter
/// (<c>@subsystem_id_3</c>, <c>@login_name_4</c>). sysproxies has no version, so an existing proxy has the identity guard and no STALE guard.
/// <see cref="LintProxySave"/> admits nothing else.</summary>
internal static partial class AgentSql
{
    /// <summary>The proxy identity guard's message (50010, NOT_FOUND).</summary>
    public const string ProxyChangedMessage = "This proxy is not the one that was read: it was deleted or replaced since. Refresh Object Explorer and try again.";
    internal const string ProxyHead = "DECLARE @proxy_id int, @rc int;\n";
    internal const string ProxyResolve = "SELECT @proxy_id = p.proxy_id FROM msdb.dbo.sysproxies AS p WHERE p.name = @name AND p.proxy_id = @expected_proxy_id;\n"
        + "IF @proxy_id IS NULL THROW 50010, N'" + ProxyChangedMessage + "', 1;\n";
    internal const string ProxyResolveByName = "SELECT @proxy_id = p.proxy_id FROM msdb.dbo.sysproxies AS p WHERE p.name = @name;\n"
        + "IF @proxy_id IS NULL THROW 50010, N'" + ProxyChangedMessage + "', 1;\n";

    private static readonly HashSet<string> ProxyProcedures = new(["sp_add_proxy", "sp_update_proxy", "sp_delete_proxy", "sp_grant_proxy_to_subsystem", "sp_revoke_proxy_from_subsystem",
        "sp_grant_login_to_proxy", "sp_revoke_login_from_proxy"], StringComparer.Ordinal);
    /// <summary>The calls whose arguments besides @proxy_id are bound to indexed parameters (one batch may make several).</summary>
    private static readonly HashSet<string> IndexedProcedures = new(["sp_grant_proxy_to_subsystem", "sp_revoke_proxy_from_subsystem", "sp_grant_login_to_proxy", "sp_revoke_login_from_proxy"], StringComparer.Ordinal);
    /// <summary>The proxy id: the batch's own variable, never a parameter.</summary>
    internal static readonly AgentParameter ProxyIdVariable = new("@proxy_id", SqlDbType.Int);
    private static readonly AgentParameter ProxyNameParameter = new("@name", SqlDbType.NVarChar, 128);
    private static readonly AgentParameter ExpectedProxyIdParameter = new("@expected_proxy_id", SqlDbType.Int);
    /// <summary>The credential block's parameters: the name (@p1), the identity and secret (nvarchar(max): the secret holds up to 4,000 characters
    /// before their quotes double), and the database whose sp_executesql runs it.</summary>
    internal static readonly AgentParameter CredentialNameParameter = new("@p1", SqlDbType.NVarChar, 128);
    internal static readonly AgentParameter IdentityParameter = new("@identity", SqlDbType.NVarChar, -1);
    internal static readonly AgentParameter SecretParameter = new("@secret", SqlDbType.NVarChar, -1);
    internal static readonly AgentParameter ModuleDatabaseParameter = new("@db", SqlDbType.NVarChar, 128);

    /// <summary>A call's argument bound to the parameter of its own name, or for the indexed calls to <c>&lt;argument&gt;_&lt;index&gt;</c>.</summary>
    public static AgentSaveArgument ProxyArgument(string procedure, int index, string argument, SqlDbType type, int size, object? value) =>
        new(argument, new(IndexedProcedures.Contains(procedure) ? argument + "_" + index.ToString(CultureInfo.InvariantCulture) : argument, type, size), value);
    /// <summary>A call's @proxy_id: the batch's variable (sp_add_proxy's as its OUTPUT).</summary>
    public static AgentSaveArgument ProxyIdArgument(bool output = false) => new("@proxy_id", ProxyIdVariable, null, output);

    /// <summary>The batch for <paramref name="calls"/>. <paramref name="name"/> and <paramref name="proxyId"/> bind an existing proxy's resolve;
    /// <paramref name="credential"/> (name, identity, secret), when set, is created first. The secret is a parameter value only: nothing here
    /// formats, logs or returns it.</summary>
    public static AgentSaveBatch ProxySave(ProxyResolution resolution, IReadOnlyList<AgentSaveCall> calls, string? name = null, int? proxyId = null,
        (string Name, string Identity, string? Secret)? credential = null)
    {
        if (calls.Count == 0 || calls.Count > CallIndexLimit) throw new InvalidOperationException("A proxy save makes 1 to 255 calls.");
        var text = new StringBuilder(ProxyHead);
        var parameters = new List<(AgentParameter, object?)>();
        switch (resolution)
        {
            case ProxyResolution.Identity:
                text.Append(ProxyResolve);
                parameters.AddRange([(ProxyNameParameter, name), (ExpectedProxyIdParameter, proxyId)]);
                break;
            case ProxyResolution.Name:
                text.Append(ProxyResolveByName);
                parameters.Add((ProxyNameParameter, name));
                break;
        }
        if (credential is { } made)
        {
            text.Append(CredentialSql.ProxyBlock);
            parameters.AddRange([(IdentityParameter, made.Identity), (SecretParameter, made.Secret), (CredentialNameParameter, made.Name), (ModuleDatabaseParameter, "master")]);
        }
        for (var i = 0; i < calls.Count; i++)
        {
            text.Append(Call(calls[i])).Append(CheckAt(i + 1));
            foreach (var argument in calls[i].Arguments)
                if (argument.Parameter.Name != ProxyIdVariable.Name) parameters.Add((argument.Parameter, argument.Value));
        }
        return new(text.ToString(), parameters, calls);
    }

    /// <summary>Problems with a proxy batch's full text; empty when it passes. It opens with <see cref="ProxyHead"/>, then at most one of
    /// <see cref="ProxyResolve"/> and <see cref="ProxyResolveByName"/> exactly, then at most one <see cref="CredentialSql.ProxyBlock"/> exactly;
    /// then each call is one msdb call of the proxy procedures the catalogue lists for writes, in the save shape, each argument once and by the
    /// parameter of its own name (the indexed calls' by <c>&lt;argument&gt;_&lt;index&gt;</c>, @proxy_id by the batch's variable, only
    /// sp_add_proxy's as its OUTPUT), followed by <see cref="CheckAt"/> with its index, counting from 1. New Proxy's (no resolve) adds the proxy
    /// first and revokes nothing; an existing proxy's updates it at most once, first, or deletes it alone; a credential block goes only with an
    /// add or an update. No other statement, literal or procedure, and never xp_servicecontrol.</summary>
    public static List<string> LintProxySave(string text, AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        var problems = new List<string>();
        if (text.Contains("xp_servicecontrol", StringComparison.OrdinalIgnoreCase)) problems.Add("uses xp_servicecontrol");
        if (!text.StartsWith(ProxyHead, StringComparison.Ordinal)) { problems.Add("does not open with the proxy's declaration"); return problems; }
        var rest = text[ProxyHead.Length..];
        var existing = false;
        foreach (var resolve in new[] { ProxyResolve, ProxyResolveByName })
            if (rest.StartsWith(resolve, StringComparison.Ordinal)) { rest = rest[resolve.Length..]; existing = true; break; }
        if (!existing && rest.StartsWith("SELECT", StringComparison.Ordinal)) { problems.Add("resolves the proxy in another shape"); return problems; }
        var credential = rest.StartsWith(CredentialSql.ProxyBlock, StringComparison.Ordinal);
        if (credential) rest = rest[CredentialSql.ProxyBlock.Length..];
        else if (rest.Length > 0 && !rest.StartsWith("EXEC @rc = ", StringComparison.Ordinal)) { problems.Add("has a statement before its calls that is not exactly the credential block"); return problems; }
        var procedures = new List<string>();
        for (var index = 1; rest.Length > 0; index++)
        {
            if (index > CallIndexLimit) { problems.Add("makes more than 255 calls"); return problems; }
            var end = rest.IndexOf('\n', StringComparison.Ordinal);
            if (end < 0) { problems.Add("call " + index + " is not followed by its return-code check"); return problems; }
            var call = rest[..end];
            rest = rest[end..];
            var check = CheckAt(index);
            if (!rest.StartsWith(check, StringComparison.Ordinal)) { problems.Add("call " + index + " is not followed by its return-code check"); return problems; }
            rest = rest[check.Length..];
            var match = SaveCall().Match(call);
            if (!match.Success) { problems.Add("call " + index + " is not one msdb call in the save shape"); return problems; }
            var procedure = match.Groups["proc"].Value;
            procedures.Add(procedure);
            if (!ProxyProcedures.Contains(procedure) || !catalog.WriteArguments.TryGetValue(procedure, out var allowed)) { problems.Add("EXECs " + procedure + ", which a proxy save does not call"); continue; }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < match.Groups["arg"].Captures.Count; i++)
            {
                var argument = match.Groups["arg"].Captures[i].Value;
                var value = match.Groups["value"].Captures[i].Value;
                var output = match.Groups["out"].Captures.Any(capture => capture.Index > match.Groups["value"].Captures[i].Index
                    && (i + 1 == match.Groups["arg"].Captures.Count || capture.Index < match.Groups["arg"].Captures[i + 1].Index));
                if (!allowed.Contains(argument)) problems.Add("passes " + argument + " to " + procedure);
                if (!seen.Add(argument)) problems.Add("passes " + argument + " twice");
                var expected = argument == "@proxy_id" ? "@proxy_id" : IndexedProcedures.Contains(procedure) ? argument + "_" + index.ToString(CultureInfo.InvariantCulture) : argument;
                if (value != expected) problems.Add("passes " + argument + " another parameter's value");
                if (output != (procedure == "sp_add_proxy" && argument == "@proxy_id")) problems.Add(output ? "passes " + argument + " as an OUTPUT" : "does not take the new proxy's id as sp_add_proxy's OUTPUT");
            }
            if (!seen.Contains("@proxy_id")) problems.Add(procedure + " does not name the proxy by its id");
            if (IndexedProcedures.Contains(procedure) && seen.Count != 2) problems.Add(procedure + " names other than one subsystem or principal");
        }
        if (procedures.Count == 0) problems.Add("makes no call");
        // msdb's principal checks doom a user transaction (AgentProxySavePlan): the principal grants and revokes run in a batch of their own.
        var logins = procedures.Count(procedure => procedure is "sp_grant_login_to_proxy" or "sp_revoke_login_from_proxy");
        if (logins > 0 && logins != procedures.Count) problems.Add("grants or revokes a principal alongside other calls");
        if (logins > 0 && credential) problems.Add("creates a credential in the principals' batch");
        if (!existing)
        {
            if (procedures.FirstOrDefault() != "sp_add_proxy" || procedures.Count(procedure => procedure == "sp_add_proxy") != 1) problems.Add("New Proxy's save does not add the proxy first, once");
            if (procedures.Any(procedure => procedure is "sp_update_proxy" or "sp_delete_proxy" or "sp_revoke_proxy_from_subsystem" or "sp_revoke_login_from_proxy")) problems.Add("New Proxy's save changes or revokes something");
        }
        else
        {
            if (procedures.Contains("sp_add_proxy")) problems.Add("adds a proxy in an existing proxy's save");
            if (procedures.Count(procedure => procedure == "sp_update_proxy") > 1 || procedures.Skip(1).Contains("sp_update_proxy")) problems.Add("updates the proxy more than once, or after a grant");
            if (procedures.Contains("sp_delete_proxy") && procedures.Count != 1) problems.Add("deletes the proxy alongside other calls");
        }
        if (credential && procedures.FirstOrDefault() is not ("sp_add_proxy" or "sp_update_proxy")) problems.Add("creates a credential without adding or updating the proxy");
        return problems;
    }

    /// <summary>The proxy batches in their shapes, under <see cref="LintProxySave"/> and <see cref="CredentialSql.LintExecutable"/> for the block,
    /// each binding exactly the parameters it uses: New Proxy's with every argument, a new credential and every kind of grant; an existing proxy's
    /// with every argument, a new credential, grants and revokes; Rename by name; Delete.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintProxySaves()
    {
        static AgentSaveArgument Text(string procedure, int index, string argument) => ProxyArgument(procedure, index, argument, SqlDbType.NVarChar, 128, "x");
        static AgentSaveArgument Number(string procedure, int index, string argument) => ProxyArgument(procedure, index, argument, SqlDbType.Int, 0, 1);
        static AgentSaveCall Grant(int index) => new("sp_grant_proxy_to_subsystem", [ProxyIdArgument(), Number("sp_grant_proxy_to_subsystem", index, "@subsystem_id")]);
        static List<AgentSaveCall> Principals(int first) =>
        [
            new("sp_grant_login_to_proxy", [ProxyIdArgument(), Text("sp_grant_login_to_proxy", first, "@login_name")]),
            new("sp_grant_login_to_proxy", [ProxyIdArgument(), Text("sp_grant_login_to_proxy", first + 1, "@fixed_server_role")]),
            new("sp_grant_login_to_proxy", [ProxyIdArgument(), Text("sp_grant_login_to_proxy", first + 2, "@msdb_role")])
        ];
        var add = new AgentSaveCall("sp_add_proxy", [Text("sp_add_proxy", 1, "@proxy_name"), new("@enabled", new("@enabled", SqlDbType.TinyInt), (byte)1), Text("sp_add_proxy", 1, "@description"),
            Text("sp_add_proxy", 1, "@credential_name"), ProxyIdArgument(output: true)]);
        var update = new AgentSaveCall("sp_update_proxy", [ProxyIdArgument(), Text("sp_update_proxy", 1, "@credential_name"), Text("sp_update_proxy", 1, "@new_name"),
            new("@enabled", new("@enabled", SqlDbType.TinyInt), (byte)0), Text("sp_update_proxy", 1, "@description")]);
        var batches = new (string Name, AgentSaveBatch Batch)[]
        {
            ("new proxy", ProxySave(ProxyResolution.Create, [add, Grant(2), Grant(3)], credential: ("c", "DOMAIN\\user", "s"))),
            ("new proxy's principals", ProxySave(ProxyResolution.Name, Principals(1), "x")),
            ("proxy update", ProxySave(ProxyResolution.Identity, [update, Grant(2),
                new("sp_revoke_proxy_from_subsystem", [ProxyIdArgument(), Number("sp_revoke_proxy_from_subsystem", 3, "@subsystem_id")])], "x", 1, ("c", "DOMAIN\\user", "s"))),
            ("proxy principals", ProxySave(ProxyResolution.Identity, [..Principals(1),
                new("sp_revoke_login_from_proxy", [ProxyIdArgument(), Text("sp_revoke_login_from_proxy", 4, "@name")])], "x", 1)),
            ("proxy rename", ProxySave(ProxyResolution.Name, [new("sp_update_proxy", [ProxyIdArgument(), Text("sp_update_proxy", 1, "@new_name")])], "x")),
            ("proxy delete", ProxySave(ProxyResolution.Identity, [new("sp_delete_proxy", [ProxyIdArgument()])], "x", 1))
        };
        foreach (var (name, batch) in batches)
        {
            var problems = LintProxySave(batch.Text);
            var at = batch.Text.IndexOf(CredentialSql.ProxyBlock, StringComparison.Ordinal);
            if (at >= 0) problems.AddRange(CredentialSql.LintExecutable(CredentialSql.ProxyBlock).Select(problem => "credential block " + problem));
            var code = Literal().Replace(batch.Text, "''");
            var locals = new HashSet<string>(["@rc", "@proxy_id", "@stmt", "@module"], StringComparer.Ordinal);
            var used = Variable().Matches(code).Select(match => match.Value).Where(variable => !locals.Contains(variable)).ToHashSet(StringComparer.Ordinal);
            // An msdb call names the procedure's argument on the left of each '='; those are not the batch's variables.
            var values = Variable().Matches(Regex.Replace(code, @"@\w+ = (?=@)", "= ")).Select(match => match.Value).Where(variable => !locals.Contains(variable)).ToHashSet(StringComparer.Ordinal);
            var bound = batch.Parameters.Select(parameter => parameter.Parameter.Name).ToHashSet(StringComparer.Ordinal);
            if (batch.Parameters.Count != bound.Count) problems.Add("binds a parameter twice");
            foreach (var variable in values.Except(bound)) problems.Add("binds the undeclared " + variable);
            foreach (var variable in bound.Except(used)) problems.Add("declares the unused " + variable);
            yield return ("proxy save " + name, problems);
        }
    }
}
