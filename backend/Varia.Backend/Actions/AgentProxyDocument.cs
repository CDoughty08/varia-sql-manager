using System.Data;
using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>The SQL Server Agent proxy document (AG-8b, docs/agent-plan.md › Alerts, operators, proxies, credentials). Proxies are sysadmin's
/// alone, so its describe refuses any other login (PERMISSION_DENIED), then reads the proxy, the subsystems, the credentials, the principals
/// and the job steps that run as it in one catalogue batch (<see cref="CredentialSql.ProxyRead"/>). Its Save is the action <c>agentProxy</c>:
/// one batch in one transaction (<see cref="AgentSql.ProxySave"/>) that resolves an existing proxy by name and the proxy_id the document read,
/// may create the credential it runs as (the request's <c>secrets.secret</c>), then updates or adds the proxy and grants and revokes its
/// subsystems and principals. A proxy's Rename and Delete from Object Explorer are the same batch with one call. A refusal names the call that
/// failed (the THROW state) and, where msdb's text tells, the field. Every message is scrubbed of the secret.</summary>
internal sealed partial class ActionService
{
    internal const string SaveProxyStep = "Save the proxy";
    internal const string CreateProxyStep = "Create the proxy";
    internal const string ProxyPrincipalsStep = "Grant and revoke principals";
    internal const string ProxySysadminMessage = "Only sysadmin can create or change SQL Server Agent proxies.";
    private static readonly IReadOnlySet<string> ProxyVerbs = new HashSet<string>(["rename", "delete"], StringComparer.Ordinal);
    private static readonly IReadOnlyDictionary<string, string> ProxyPrincipalArguments = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["login"] = "@login_name", ["serverRole"] = "@fixed_server_role", ["msdbRole"] = "@msdb_role"
    };

    /// <summary>A secret of at most agentLimits.credentialSecretChars UTF-16 units, never blank, without U+0000 or an unpaired surrogate. The
    /// message names the member, never the value.</summary>
    private static void CredentialSecret(string? value)
    {
        if (value is null || value.Length == 0 || value.Length > AgentCatalog.Current.Limit("credentialSecretChars") || value.Contains('\0') || ScriptingErrors.UnpairedSurrogate(value) >= 0)
            throw Invalid("secrets.secret.");
    }

    /// <summary>A credential identity: 1 to agentLimits.credentialIdentityChars UTF-16 units, without U+0000 or an unpaired surrogate.</summary>
    private static bool CredentialIdentity(string? value) =>
        value is { Length: > 0 } && value.Length <= AgentCatalog.Current.Limit("credentialIdentityChars") && !value.Contains('\0') && ScriptingErrors.UnpairedSurrogate(value) < 0;

    /// <summary>The secrets a credential save carries: the secret alone, on execute only (Validate refuses secrets on a script).</summary>
    private static void CredentialSecrets(ActionArgs args, bool required)
    {
        if (args.Secrets is { Password: not null } or { OldPassword: not null }) throw Invalid("a credential's save takes only secrets.secret.");
        if (required) CredentialSecret(args.Secrets?.Secret);
        else if (args.Secrets is not null) throw Invalid("secrets go only with a new credential.");
    }

    /// <summary>Re-validates the agentProxy request (src/shared/actions/schema.ts agentProxyRequestSchema, agent-proxy.ts agentProxySaveProblems)
    /// and a proxy's Rename and Delete. Null for anything else, after refusing the proxy's members on it. An existing proxy's save names its
    /// proxyId (Script may leave it out); New Proxy's targets the SQL Server Agent node with none. A new credential goes with the secret.</summary>
    private ObjectRefDto? ValidateAgentProxy(ActionArgs args, bool script)
    {
        var onProxy = args.Target?.Kind == "agentProxy";
        if (args.Action != "agentProxy" && !onProxy)
        {
            if (args.AgentProxy is not null || args.ProxyId is not null) throw Invalid(args.Action + " takes no agentProxy or proxyId.");
            return null;
        }
        if (args.AgentProxy is not null && args.Action != "agentProxy") throw Invalid(args.Action + " takes no agentProxy.");
        if (args.ProxyId is < 1) throw Invalid("proxyId.");
        var bare = new ActionArgs(args.Action, args.ConnectionId, args.RequestId, args.Target!);
        if (args.Action != "agentProxy")
        {
            if (!ProxyVerbs.Contains(args.Action)) throw Invalid("target.");
            var verbTarget = Target(args.Target, args.Action);
            if (args.Secrets is not null) throw Invalid(args.Action + " takes no secrets.");
            if (args with { ProxyId = null, NewName = null, CloseConnections = null, DeleteHistory = null } != bare) throw Invalid(args.Action + " on a proxy takes no such member.");
            if (args.Action == "rename")
            {
                if (!ExplorerRefs.Ident(args.NewName)) throw Invalid("newName.");
                if (string.Equals(args.NewName, verbTarget.Name, StringComparison.Ordinal)) throw Invalid("the new name is the current name.");
                if (args.CloseConnections is not null || args.DeleteHistory is not null) throw Invalid("rename takes no delete options.");
            }
            else
            {
                if (args.NewName is not null || args.CloseConnections is not false || args.DeleteHistory is not false) throw Invalid("a proxy's delete takes closeConnections and deleteHistory false.");
                if (args.ProxyId is null && !script) throw Invalid("a proxy's delete needs the proxy id it read.");
            }
            return verbTarget;
        }
        if (args.AgentProxy is not { } save) throw Invalid("agentProxy.");
        var create = args.Target is { Kind: "agent" };
        ObjectRefDto target;
        if (create)
        {
            if (args.Target is not { Kind: "agent", Name: null, Database: null, Schema: null, Parent: null, SsisFolder: null, SsisProject: null }) throw Invalid("target.");
            target = Target(args.Target, "agentProperties");
            if (args.ProxyId is not null) throw Invalid("a new proxy has no id.");
        }
        else
        {
            if (!onProxy) throw Invalid("target.");
            target = Target(args.Target, "agentProxy");
            if (args.ProxyId is null && !script) throw Invalid("proxyId.");
        }
        if (args with { AgentProxy = null, ProxyId = null, Secrets = null } != bare) throw Invalid("agentProxy takes only the save, the proxy's id and the secret.");
        if (!script) CredentialSecrets(args, required: save.NewCredential is not null);
        var limits = AgentCatalog.Current;
        var names = (int)limits.Limit("nameChars");
        if (save.Name is not null && !ExplorerRefs.Ident(save.Name, names)) throw Invalid("agentProxy.name.");
        if (save.Description is { } description && (description.Length > limits.Limit("descriptionChars") || description.Contains('\0'))) throw Invalid("agentProxy.description.");
        if (save.Credential is not null && !ExplorerRefs.Ident(save.Credential, names)) throw Invalid("agentProxy.credential.");
        if (save.NewCredential is { } made && (!ExplorerRefs.Ident(made.Name, names) || !CredentialIdentity(made.Identity))) throw Invalid("agentProxy.newCredential.");
        if (save.Credential is not null && save.NewCredential is not null) throw Invalid("a proxy runs as one credential.");
        var subsystemCap = limits.Limit("proxySubsystems");
        foreach (var list in new[] { save.GrantSubsystems, save.RevokeSubsystems })
            if (list is not null && (list.Count == 0 || list.Count > subsystemCap || list.Any(id => id < 1))) throw Invalid("agentProxy subsystems.");
        var ids = (save.GrantSubsystems ?? []).Concat(save.RevokeSubsystems ?? []).ToList();
        if (ids.Distinct().Count() != ids.Count) throw Invalid("a subsystem is granted or revoked twice.");
        var principalCap = limits.Limit("proxyPrincipals");
        if (save.GrantPrincipals is { } grants && (grants.Count == 0 || grants.Count > principalCap || grants.Any(principal => !ExplorerRefs.Ident(principal.Name, names) || !ProxyPrincipalArguments.ContainsKey(principal.Kind))))
            throw Invalid("agentProxy.grantPrincipals.");
        if (save.RevokePrincipals is { } revokes && (revokes.Count == 0 || revokes.Count > principalCap || revokes.Any(name => !ExplorerRefs.Ident(name, names)))) throw Invalid("agentProxy.revokePrincipals.");
        var principals = (save.GrantPrincipals ?? []).Select(principal => principal.Name).Concat(save.RevokePrincipals ?? []).ToList();
        if (principals.Distinct(StringComparer.OrdinalIgnoreCase).Count() != principals.Count) throw Invalid("a principal is granted or revoked twice.");
        if (create)
        {
            if (save.Name is null || (save.Credential is null && save.NewCredential is null)) throw Invalid("a new proxy has a name and a credential.");
            if (save.RevokeSubsystems is not null || save.RevokePrincipals is not null) throw Invalid("a new proxy has nothing to revoke.");
        }
        else if (save == new AgentProxySaveDto()) throw Invalid("there is nothing to change.");
        return target;
    }

    // --- Describe ----------------------------------------------------------------------------------------------------------

    private static object? Field(SqlDataReader reader, string column) => reader[column] is DBNull ? null : reader[column];
    private static string ProxyKind(int flags) => flags switch { 1 => "serverRole", 2 => "msdbRole", _ => "login" };
    private ActionError ProxyGone(ObjectRefDto target) => Error("NOT_FOUND", "The proxy " + Display(target) + " no longer exists. Refresh Object Explorer.");

    /// <summary>Whether the login is sysadmin and may create credentials (<see cref="CredentialSql.ProxyFacts"/>).</summary>
    private static async Task<(bool Sysadmin, bool CanAlter)> ReadProxyFactsAsync(SqlConnection connection, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = CredentialSql.ProxyFacts;
        command.CommandTimeout = 0;
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return (false, false);
        return (Convert.ToBoolean(reader.GetValue(0), CultureInfo.InvariantCulture), Convert.ToBoolean(reader.GetValue(1), CultureInfo.InvariantCulture));
    }

    /// <summary>The proxy document's describe: the proxy named by <paramref name="target"/> (an agentProxy), or New Proxy's choices (the Agent node).</summary>
    private async Task<ActionDescribeResult> DescribeAgentProxyDocumentAsync(SqlConnection connection, ServerProfile profile, ObjectRefDto target, CancellationToken token)
    {
        var limits = AgentCatalog.Current;
        if (limits.PlatformOf(profile.EngineEdition, profile.Linux) is not { } platform) return new(null, 0, Error("NOT_SUPPORTED", AgentProfileSql.Unsupported(profile.EngineEdition)));
        var (sysadmin, canAlter) = await ReadProxyFactsAsync(connection, token);
        if (!sysadmin) return new(null, 0, Error("PERMISSION_DENIED", ProxySysadminMessage));
        int Cap(string limit) => (int)limits.Limit(limit);
        await using var command = connection.CreateCommand();
        command.CommandText = CredentialSql.ProxyRead;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, target.Kind == "agentProxy" ? target.Name : null);
        Add(command, "@principals", SqlDbType.Int, 0, Cap("proxyPrincipals") + 1);
        Add(command, "@credentials", SqlDbType.Int, 0, Cap("credentials") + 1);
        Add(command, "@choices", SqlDbType.Int, 0, Cap("principalChoices") + 1);
        Add(command, "@references", SqlDbType.Int, 0, Cap("proxyReferences") + 1);
        await using var reader = await command.ExecuteReaderAsync(token);
        (int Id, string Name, bool Enabled, string Description, string Credential, string? Identity)? row = null;
        if (await reader.ReadAsync(token))
            row = (reader.GetInt32(0), reader.GetString(1), Convert.ToInt32(reader.GetValue(2), CultureInfo.InvariantCulture) != 0, TextOf(Field(reader, "description")), TextOf(Field(reader, "credential")),
                Field(reader, "credential_identity") as string);
        if (target.Kind == "agentProxy" && row is null) return new(null, 0, ProxyGone(target));
        var subsystems = new List<ProxySubsystemDto>();
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token)) subsystems.Add(new(reader.GetInt32(0), reader.GetString(1)));
        var active = new List<int>();
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token)) active.Add(reader.GetInt32(0));
        var principals = new List<ProxyPrincipalDto>();
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token)) principals.Add(new(reader.GetString(0), ProxyKind(IntOf(reader.GetValue(1)))));
        var credentials = new List<ProxyCredentialDto>();
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token)) credentials.Add(new(reader.GetString(0), TextOf(Field(reader, "credential_identity"))));
        var choices = new List<ProxyPrincipalDto>();
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token)) choices.Add(new(reader.GetString(0), ProxyKind(IntOf(reader.GetValue(1)))));
        var references = new List<ProxyReferenceDto>();
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token)) references.Add(new(reader.GetString(0), reader.GetInt32(1), reader.GetString(2), reader.GetString(3)));
        var credentialsTruncated = credentials.Count > Cap("credentials");
        var referencesTruncated = references.Count > Cap("proxyReferences");
        AgentProxyRecordDto? proxy = row is { } found
            ? new(found.Id, found.Name, found.Enabled, found.Description, found.Credential, [.. active.Order()], [.. principals.Take(Cap("proxyPrincipals"))], found.Identity) : null;
        return new(null, 0, AgentProxyDocument: new(proxy, platform, subsystems, [.. credentials.Take(Cap("credentials"))], credentialsTruncated, canAlter, [.. choices.Take(Cap("principalChoices"))],
            proxy is null ? null : [.. references.Take(Cap("proxyReferences"))], proxy is null ? null : referencesTruncated, proxy is null ? null : principals.Count > Cap("proxyPrincipals")));
    }

    /// <summary>Delete Object's row for a proxy (sysadmin): its name and the proxy_id the Delete request names.</summary>
    private async Task<ActionDescribeResult> DescribeAgentProxyDeleteAsync(SqlConnection connection, ObjectRefDto target, CancellationToken token)
    {
        var (sysadmin, _) = await ReadProxyFactsAsync(connection, token);
        if (!sysadmin) return new(null, 0, Error("PERMISSION_DENIED", ProxySysadminMessage));
        await using var command = connection.CreateCommand();
        command.CommandText = CredentialSql.ProxyByName;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, target.Name);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return new(null, 0, ProxyGone(target));
        return new(new DeleteTargetDto(reader.GetString(1), "Proxy", null, [], false, ProxyId: reader.GetInt32(0)), 0);
    }

    // --- Plan --------------------------------------------------------------------------------------------------------------

    /// <summary>The save's two batches. The first, in a transaction: New Proxy's sp_add_proxy with the arguments the request sets (an unset one
    /// keeps sp_add_proxy's default), or an existing proxy's sp_update_proxy with only the changed arguments (none when only grants change), then
    /// one call per subsystem grant and revoke; a new credential is created first, under the name the proxy then names. The second, without a
    /// transaction, after the first commits: one call per principal grant and revoke, resolving the proxy by its saved name (and the id read, for
    /// an existing proxy). msdb checks a principal that is not a login with EXECUTE AS LOGIN inside TRY/CATCH, which dooms any user transaction
    /// (3930), so those calls cannot share one. Either batch is null when it would make no call.</summary>
    internal static ProxySavePlan AgentProxySavePlan(ActionArgs args, ObjectRefDto target)
    {
        var save = args.AgentProxy!;
        var create = target.Kind == "agent";
        var credential = save.NewCredential?.Name ?? save.Credential;
        var calls = new List<AgentSaveCall>();
        AgentSaveArgument Text(List<AgentSaveCall> into, string procedure, string argument, int size, string value) => AgentSql.ProxyArgument(procedure, into.Count + 1, argument, SqlDbType.NVarChar, size, value);
        var arguments = new List<AgentSaveArgument>();
        var main = create ? "sp_add_proxy" : "sp_update_proxy";
        if (create) arguments.Add(Text(calls, main, "@proxy_name", 128, save.Name!));
        else arguments.Add(AgentSql.ProxyIdArgument());
        if (!create && credential is not null) arguments.Add(Text(calls, main, "@credential_name", 128, credential));
        if (!create && save.Name is not null) arguments.Add(Text(calls, main, "@new_name", 128, save.Name));
        if (save.Enabled is { } enabled) arguments.Add(new("@enabled", new("@enabled", SqlDbType.TinyInt), (byte)(enabled ? 1 : 0)));
        if (save.Description is { } description) arguments.Add(Text(calls, main, "@description", 512, description));
        if (create)
        {
            arguments.Add(Text(calls, main, "@credential_name", 128, credential!));
            arguments.Add(AgentSql.ProxyIdArgument(output: true));
        }
        if (create || arguments.Count > 1) calls.Add(new(main, arguments));
        void Subsystem(string procedure, int id) => calls.Add(new(procedure, [AgentSql.ProxyIdArgument(), AgentSql.ProxyArgument(procedure, calls.Count + 1, "@subsystem_id", SqlDbType.Int, 0, id)]));
        foreach (var id in save.GrantSubsystems ?? []) Subsystem("sp_grant_proxy_to_subsystem", id);
        foreach (var id in save.RevokeSubsystems ?? []) Subsystem("sp_revoke_proxy_from_subsystem", id);
        var principals = new List<AgentSaveCall>();
        foreach (var principal in save.GrantPrincipals ?? [])
            principals.Add(new("sp_grant_login_to_proxy", [AgentSql.ProxyIdArgument(), Text(principals, "sp_grant_login_to_proxy", ProxyPrincipalArguments[principal.Kind], 128, principal.Name)]));
        foreach (var name in save.RevokePrincipals ?? []) principals.Add(new("sp_revoke_login_from_proxy", [AgentSql.ProxyIdArgument(), Text(principals, "sp_revoke_login_from_proxy", "@name", 128, name)]));
        (string, string, string?)? made = save.NewCredential is { } spec ? (spec.Name, spec.Identity, args.Secrets?.Secret) : null;
        var first = calls.Count == 0 ? null
            : create ? AgentSql.ProxySave(ProxyResolution.Create, calls, credential: made) : AgentSql.ProxySave(ProxyResolution.Identity, calls, target.Name, args.ProxyId, made);
        var saved = save.Name ?? target.Name;
        var second = principals.Count == 0 ? null
            : create ? AgentSql.ProxySave(ProxyResolution.Name, principals, saved) : AgentSql.ProxySave(ProxyResolution.Identity, principals, saved, args.ProxyId);
        return new(first, second);
    }

    /// <summary>Every call the save makes, in order: the script's.</summary>
    internal static IEnumerable<AgentSaveCall> Calls(ProxySavePlan plan) => (plan.Main?.Calls ?? []).Concat(plan.Principals?.Calls ?? []);

    /// <summary>A proxy's Rename (by the id when the caller read it, else by name: Object Explorer's row has none) or Delete (by the id).</summary>
    internal static AgentSaveBatch AgentProxyVerbPlan(ActionArgs args, ObjectRefDto target) => args.Action == "rename"
        ? AgentSql.ProxySave(args.ProxyId is null ? ProxyResolution.Name : ProxyResolution.Identity,
            [new("sp_update_proxy", [AgentSql.ProxyIdArgument(), AgentSql.ProxyArgument("sp_update_proxy", 1, "@new_name", SqlDbType.NVarChar, 128, args.NewName)])], target.Name, args.ProxyId)
        : AgentSql.ProxySave(ProxyResolution.Identity, [new("sp_delete_proxy", [AgentSql.ProxyIdArgument()])], target.Name, args.ProxyId);

    // --- Execute -----------------------------------------------------------------------------------------------------------

    /// <summary>Runs one guarded batch in its own transaction, committing only when every statement ran; a SqlException is rethrown after the
    /// rollback, for the caller to map.</summary>
    private async Task RunGuardedBatchAsync(SqlConnection connection, string text, IEnumerable<(AgentParameter Parameter, object? Value)> parameters, CancellationToken token)
    {
        var open = (SqlTransaction)await connection.BeginTransactionAsync(token);
        var committed = false;
        try
        {
            await using var command = connection.CreateCommand();
            command.Transaction = open;
            command.CommandText = text;
            command.CommandTimeout = 0;
            foreach (var (parameter, value) in parameters) Add(command, parameter.Name, parameter.Type, parameter.Size, value);
            await ReadAllAsync(command, token);
            await open.CommitAsync(CancellationToken.None);
            committed = true;
        }
        finally
        {
            // XACT_ABORT has rolled back a failed batch's transaction already (its Connection is then null).
            if (!committed && open.Connection is not null)
            {
                try { await open.RollbackAsync(CancellationToken.None).WaitAsync(Options.StopGrace, CancellationToken.None); }
                catch (Exception) { try { await connection.CloseAsync(); } catch (Exception) { } }
            }
            await open.DisposeAsync();
        }
    }

    /// <summary>Runs the principals' batch without a transaction (see <see cref="AgentProxySavePlan"/>): the action's XACT_ABORT prologue stops
    /// it at the first refusal, and the grants and revokes before it stay made.</summary>
    private static async Task RunAutocommitBatchAsync(SqlConnection connection, AgentSaveBatch batch, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = batch.Text;
        command.CommandTimeout = 0;
        foreach (var (parameter, value) in batch.Parameters) Add(command, parameter.Name, parameter.Type, parameter.Size, value);
        await ReadAllAsync(command, token);
    }

    private async Task<ActionExecuteResult> ExecuteAgentProxyAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var verb = args.Action != "agentProxy";
        var plan = verb ? new ProxySavePlan(AgentProxyVerbPlan(args, target), null) : AgentProxySavePlan(args, target);
        var secret = args.Secrets?.Secret;
        string Scrubbed(string text) => CredentialSql.Scrub(text, secret);
        var messages = CollectMessages(connection);
        var title = args.Action switch { "rename" => "Rename the proxy", "delete" => "Delete the proxy", _ => target.Kind == "agent" ? CreateProxyStep : SaveProxyStep };
        var detail = args.NewName ?? args.AgentProxy?.Name ?? target.Name;
        var steps = new List<RunStep>();
        if (plan.Main is { } main)
            steps.Add(new RunStep(title, async context =>
            {
                try { await RunGuardedBatchAsync(connection, main.Text, main.Parameters, context.Token); }
                catch (SqlException error) when (!context.Token.IsCancellationRequested && connection.State == ConnectionState.Open)
                {
                    throw new StepRefusedException(ProxySaveError(error, main, connection, verb, args.AgentProxy?.NewCredential is not null, secret));
                }
            }, Detail: detail));
        if (plan.Principals is { } principals)
            steps.Add(new RunStep(ProxyPrincipalsStep, async context =>
            {
                try { await RunAutocommitBatchAsync(connection, principals, context.Token); }
                catch (SqlException error) when (!context.Token.IsCancellationRequested && connection.State == ConnectionState.Open)
                {
                    throw new StepRefusedException(ProxySaveError(error, principals, connection, verb, false, secret));
                }
            }, Detail: detail));
        var (done, failure, _) = await RunStepsAsync(connection, steps, null, token, CleanupBudget(args.Action), serverText: Scrubbed);
        return new(done, [.. messages.Collected().Select(Scrubbed)], 0, failure);
    }

    /// <summary>The field an msdb argument a refusal names is (agent-proxy.ts agentProxyFields).</summary>
    internal static string? ProxyFieldOf(string argument) => argument switch
    {
        "@proxy_name" or "@new_name" => "name",
        "@credential_name" or "@credential_id" => "credential",
        "@enabled" => "enabled",
        "@description" => "description",
        "@subsystem_id" or "@subsystem_name" => "subsystems",
        "@login_name" or "@fixed_server_role" or "@msdb_role" or "@name" => "principals",
        _ => null
    };

    /// <summary>What a refused proxy batch says. 50010 is NOT_FOUND (another proxy has the name). Otherwise msdb's own error maps by number
    /// (ActionErrors), and the THROW's state names the call that failed: the message says which part and the field is the argument msdb's text
    /// names, else the name for NAME_IN_USE, the list a grant or revoke belongs to. With no THROW the batch aborted before any call: CREATE
    /// CREDENTIAL's refusal when the save made one (the credential field), else nothing was saved. The text is scrubbed of the secret.</summary>
    internal ActionError ProxySaveError(SqlException error, AgentSaveBatch batch, SqlConnection? connection, bool verb, bool madeCredential, string? secret)
    {
        var errors = error.Errors.Cast<SqlError>().ToList();
        var first = errors.FirstOrDefault(item => item.Class > 10)?.Number ?? error.Number;
        if (first == 50010) return Error("NOT_FOUND", AgentSql.ProxyChangedMessage);
        if (first == 15281) return Error("AGENT_STOPPED", AgentStoppedMessage);
        var mapped = ActionErrors.FromSql(catalog, error, connection, ddl: true, null);
        if (mapped.Code == "NOT_FOUND") mapped = mapped with { Code = "SQL_ERROR", Retryable = false };
        var text = CredentialSql.Scrub(string.Join(" ", errors.Where(item => item.Class > 10 && item.Number is not (50012 or 3621 or 3998)).Select(item => item.Message).Distinct()), secret);
        var thrown = errors.FirstOrDefault(item => item.Number == 50012);
        if (thrown is null || thrown.State < 1 || thrown.State > batch.Calls.Count)
        {
            if (madeCredential)
                return ActionErrors.Create(catalog, mapped.Code, "Creating the credential was refused: " + (text.Length > 0 ? text : AgentSql.RefusedMessage)) with { Field = "credential", Retryable = mapped.Retryable };
            return ActionErrors.Create(catalog, mapped.Code, JobSaveAbortedMessage + (text.Length > 0 ? " " + text : "")) with { Retryable = mapped.Retryable };
        }
        var call = batch.Calls[thrown.State - 1];
        if (verb) return ActionErrors.Create(catalog, mapped.Code, text.Length > 0 ? text : AgentSql.RefusedMessage) with { Field = mapped.Code == "NAME_IN_USE" ? "name" : null, Retryable = mapped.Retryable };
        string Named() => call.Arguments.FirstOrDefault(argument => argument.Name != "@proxy_id")?.Value is { } value ? Convert.ToString(value, CultureInfo.InvariantCulture) ?? "" : "";
        var part = call.Procedure switch
        {
            "sp_add_proxy" => "Creating the proxy",
            "sp_grant_proxy_to_subsystem" => "Granting a subsystem",
            "sp_revoke_proxy_from_subsystem" => "Revoking a subsystem",
            "sp_grant_login_to_proxy" => "Granting '" + Named() + "' the proxy",
            "sp_revoke_login_from_proxy" => "Revoking '" + Named() + "'",
            _ => "Changing the proxy's settings"
        };
        // msdb's 14261 names the proxy as @name, which on a grant would be a principal: a taken name on an add or update is the name field.
        var field = mapped.Code == "NAME_IN_USE" && call.Procedure is "sp_add_proxy" or "sp_update_proxy" ? "name"
            : NamedArgument().Matches(text).Select(match => ProxyFieldOf(match.Groups["arg"].Value)).FirstOrDefault(found => found is not null);
        field ??= call.Procedure switch
        {
            "sp_grant_proxy_to_subsystem" or "sp_revoke_proxy_from_subsystem" => "subsystems",
            "sp_grant_login_to_proxy" or "sp_revoke_login_from_proxy" => "principals",
            _ => call.Arguments.Select(argument => ProxyFieldOf(argument.Name)).Where(found => found is not null).Distinct().ToList() is { Count: 1 } only ? only[0] : null
        };
        return ActionErrors.Create(catalog, mapped.Code, part + " was refused: " + (text.Length > 0 ? text : AgentSql.RefusedMessage)) with { Field = field, Retryable = mapped.Retryable };
    }

    // --- Script ------------------------------------------------------------------------------------------------------------

    /// <summary>The save's script as SSMS writes a proxy's: CREATE CREDENTIAL first (in master, the secret <see cref="CredentialSql.Placeholder"/>),
    /// then each msdb call by the proxy's name (the new name after a rename) with literal values, one batch each.</summary>
    internal static string AgentProxyScript(ActionArgs args, ObjectRefDto target)
    {
        var verb = args.Action != "agentProxy";
        var calls = verb ? AgentProxyVerbPlan(args, target).Calls : Calls(AgentProxySavePlan(args, target));
        static string Value(object? value) => value switch
        {
            string text => Literal(text),
            byte or int => Convert.ToString(value, CultureInfo.InvariantCulture)!,
            _ => throw new InvalidOperationException("Not a script value.")
        };
        var text = new StringBuilder();
        if (args.AgentProxy?.NewCredential is { } made) text.Append("USE [master]\nGO\n").Append(CredentialSql.ScriptStatement(true, made.Name, made.Identity, null)).Append("\nGO\n");
        text.Append("USE [msdb]\nGO\n");
        var name = target.Kind == "agent" ? args.AgentProxy!.Name! : target.Name!;
        foreach (var call in calls)
        {
            var parts = call.Arguments.Where(argument => !argument.Output).Select(argument => argument.Name == "@proxy_id" ? "@proxy_name=" + Literal(name) : argument.Name + "=" + Value(argument.Value));
            text.Append("EXEC msdb.dbo.").Append(call.Procedure).Append(' ').Append(string.Join(", ", parts)).Append("\nGO\n");
            if (call.Arguments.FirstOrDefault(argument => argument.Name is "@new_name" or "@proxy_name")?.Value is string renamed) name = renamed;
        }
        return text.ToString();
    }

    private Task<ActionScriptResult> ScriptAgentProxy(ActionArgs args, ObjectRefDto target)
    {
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (!Serves(args.Action, engine)) return Task.FromResult(new ActionScriptResult(null, "msdb", [], Error("NOT_SUPPORTED", EngineMessage(engine))));
        return Task.FromResult(new ActionScriptResult(AgentProxyScript(args, target), "msdb", []));
    }
}
