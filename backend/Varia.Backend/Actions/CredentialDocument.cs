using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Actions;

/// <summary>The Credential document (AG-8b). Its describe reads the credential (never its secret, which SQL Server does not return), the
/// enabled cryptographic providers and, for sysadmin, Used by: the proxies that run as it with their subsystems and job steps. Without ALTER
/// ANY CREDENTIAL it opens read-only. Its Save is the action <c>credential</c>: CREATE CREDENTIAL on the server, or an existing credential's
/// ALTER CREDENTIAL behind the STALE guard (credential_id, name and modify_date as read), each built on the server
/// (<see cref="CredentialSql.Executable"/>) with the request's <c>secrets.secret</c>; Script writes <see cref="CredentialSql.Placeholder"/>.</summary>
internal sealed partial class ActionService
{
    internal const string SaveCredentialStep = "Save the credential";
    internal const string CreateCredentialStep = "Create the credential";
    internal const string CredentialReadOnlyMessage = "ALTER ANY CREDENTIAL is needed to change it.";

    /// <summary>Re-validates the credential request (src/shared/actions/schema.ts credentialRequestSchema, agent-proxy.ts credentialSaveProblems).
    /// Null for any other action, after refusing the credential save's member on it. New Credential's targets the server with a name and no
    /// id; an existing credential's targets it with its id and modified date and no name or provider. The secret always goes on execute.</summary>
    private ObjectRefDto? ValidateCredential(ActionArgs args, bool script)
    {
        if (args.Action != "credential")
        {
            if (args.Credential is not null) throw Invalid(args.Action + " takes no credential.");
            return null;
        }
        if (args.Credential is not { } save) throw Invalid("credential.");
        var create = args.Target is { Kind: "server" };
        var target = create ? ServerTarget(args.Target) : args.Target?.Kind == "credential" ? Target(args.Target, "credential") : throw Invalid("target.");
        if (args with { Credential = null, Secrets = null } != new ActionArgs(args.Action, args.ConnectionId, args.RequestId, args.Target!)) throw Invalid("credential takes only the save and the secret.");
        if (!script) CredentialSecrets(args, required: true);
        var names = (int)AgentCatalog.Current.Limit("nameChars");
        if (!CredentialIdentity(save.Identity)) throw Invalid("credential.identity.");
        if (create)
        {
            if (save.Name is null || !ExplorerRefs.Ident(save.Name, names) || save.Id is not null || save.Modified is not null) throw Invalid("a new credential has a name and no identity to check.");
            if (save.Provider is not null && !ExplorerRefs.Ident(save.Provider, names)) throw Invalid("credential.provider.");
        }
        else
        {
            if (save.Id is not >= 1 || save.Modified is null || JobModified(save.Modified) is null) throw Invalid("credential.modified.");
            if (save.Name is not null || save.Provider is not null) throw Invalid("ALTER CREDENTIAL changes neither a credential's name nor its provider.");
        }
        return target;
    }

    private static string Stamp(object? value, string format) => value is DateTime date ? date.ToString(format, CultureInfo.InvariantCulture) : "";

    /// <summary>The credential document's describe: the credential named by <paramref name="target"/>, or New Credential's choices (the server).</summary>
    private async Task<ActionDescribeResult> DescribeCredentialDocumentAsync(SqlConnection connection, ServerProfile profile, ObjectRefDto target, CancellationToken token)
    {
        var limits = AgentCatalog.Current;
        int Cap(string limit) => (int)limits.Limit(limit);
        var platform = profile.Explorer(explorer).ServerEngine == "managedInstance" ? "managedInstance" : "box";
        bool sysadmin, canAlter;
        CredentialRecordDto? credential = null;
        var providers = new List<string>();
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = CredentialSql.CredentialRead;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, target.Kind == "credential" ? target.Name : null);
            Add(command, "@providers", SqlDbType.Int, 0, Cap("cryptographicProviders") + 1);
            await using var reader = await command.ExecuteReaderAsync(token);
            if (!await reader.ReadAsync(token)) return new(null, 0, Error("SQL_ERROR", AgentReader.FailedMessage));
            sysadmin = Convert.ToBoolean(reader.GetValue(0), CultureInfo.InvariantCulture);
            canAlter = Convert.ToBoolean(reader.GetValue(1), CultureInfo.InvariantCulture);
            await reader.NextResultAsync(token);
            if (await reader.ReadAsync(token))
                credential = new(reader.GetInt32(0), reader.GetString(1), TextOf(Field(reader, "credential_identity")), Stamp(Field(reader, "created"), "yyyy-MM-dd'T'HH:mm:ss"),
                    Stamp(Field(reader, "modified"), "yyyy-MM-dd'T'HH:mm:ss.fff"), Field(reader, "provider") as string);
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token)) providers.Add(reader.GetString(0));
        }
        if (target.Kind == "credential" && credential is null) return new(null, 0, Error("NOT_FOUND", "The credential " + Display(target) + " no longer exists. Refresh Object Explorer."));
        List<CredentialUseDto>? usedBy = null;
        bool? usedByTruncated = null;
        if (sysadmin && credential is not null) (usedBy, usedByTruncated) = await ReadUsedByAsync(connection, credential.Id, token);
        return new(null, 0, CredentialDocument: new(credential, platform, [.. providers.Take(Cap("cryptographicProviders"))], canAlter ? null : CredentialReadOnlyMessage, usedBy, usedByTruncated));
    }

    /// <summary>The proxies that run as the credential, each with its subsystems and job steps; null when msdb refuses the read (a Managed
    /// Instance without proxies, say), which the document then does not list.</summary>
    private static async Task<(List<CredentialUseDto>?, bool?)> ReadUsedByAsync(SqlConnection connection, int credentialId, CancellationToken token)
    {
        var limits = AgentCatalog.Current;
        int Cap(string limit) => (int)limits.Limit(limit);
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = CredentialSql.CredentialUsedBy;
            command.CommandTimeout = 0;
            Add(command, "@credential_id", SqlDbType.Int, 0, credentialId);
            Add(command, "@proxies", SqlDbType.Int, 0, Cap("credentialProxies") + 1);
            Add(command, "@references", SqlDbType.Int, 0, Cap("proxyReferences") + 1);
            await using var reader = await command.ExecuteReaderAsync(token);
            var proxies = new List<(int Id, string Name)>();
            while (await reader.ReadAsync(token)) proxies.Add((reader.GetInt32(0), reader.GetString(1)));
            var subsystems = new List<(int Id, string Name)>();
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token)) subsystems.Add((reader.GetInt32(0), reader.GetString(1)));
            var steps = new List<(int Id, CredentialStepDto Step)>();
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token)) steps.Add((reader.GetInt32(0), new(reader.GetString(1), reader.GetInt32(2), reader.GetString(3))));
            var truncated = proxies.Count > Cap("credentialProxies") || steps.Count > Cap("proxyReferences");
            var listedSteps = steps.Take(Cap("proxyReferences")).ToList();
            var uses = proxies.Take(Cap("credentialProxies")).Select(proxy => new CredentialUseDto(proxy.Name,
                [.. subsystems.Where(item => item.Id == proxy.Id).Select(item => item.Name)], [.. listedSteps.Where(item => item.Id == proxy.Id).Select(item => item.Step)])).ToList();
            return (uses, truncated);
        }
        // 229 and 916: msdb refuses the login; 208: no such table on this server.
        catch (SqlException error) when (!token.IsCancellationRequested && connection.State == ConnectionState.Open && FirstNumber(error) is 229 or 208 or 916)
        {
            return (null, null);
        }
    }

    /// <summary>The credential batch's parameters: the identity and secret (nvarchar(max)), the name (@p1, the target's for an ALTER), the
    /// database whose sp_executesql runs it, a New Credential's provider (@p2) and an existing one's STALE guard.</summary>
    internal static List<(AgentParameter Parameter, object? Value)> CredentialParameters(ActionArgs args, ObjectRefDto target)
    {
        var save = args.Credential!;
        var create = target.Kind == "server";
        var parameters = new List<(AgentParameter, object?)>
        {
            (AgentSql.IdentityParameter, save.Identity), (AgentSql.SecretParameter, args.Secrets?.Secret), (AgentSql.CredentialNameParameter, create ? save.Name : target.Name),
            (AgentSql.ModuleDatabaseParameter, "master")
        };
        if (save.Provider is { } provider) parameters.Add((new AgentParameter("@p2", SqlDbType.NVarChar, 128), provider));
        if (!create) parameters.AddRange([(new AgentParameter("@credential_id", SqlDbType.Int), save.Id), (new AgentParameter("@modified", SqlDbType.DateTime), JobModified(save.Modified!))]);
        return parameters;
    }

    private async Task<ActionExecuteResult> ExecuteCredentialAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var save = args.Credential!;
        var create = target.Kind == "server";
        var text = CredentialSql.Executable(create, save.Provider is not null);
        var parameters = CredentialParameters(args, target);
        var secret = args.Secrets?.Secret;
        string Scrubbed(string message) => CredentialSql.Scrub(message, secret);
        var messages = CollectMessages(connection);
        var step = new RunStep(create ? CreateCredentialStep : SaveCredentialStep, async context =>
        {
            try { await RunGuardedBatchAsync(connection, text, parameters, context.Token); }
            catch (SqlException error) when (!context.Token.IsCancellationRequested && connection.State == ConnectionState.Open)
            {
                throw new StepRefusedException(CredentialSaveError(error, connection, secret));
            }
        }, Detail: create ? save.Name : target.Name);
        var (steps, failure, _) = await RunStepsAsync(connection, [step], null, token, CleanupBudget(args.Action), serverText: Scrubbed);
        return new(steps, [.. messages.Collected().Select(Scrubbed)], 0, failure);
    }

    /// <summary>What a refused credential save says: 50011 is STALE; SQL Server's own error maps by number (15530, the name in use, on the name
    /// field), its text scrubbed of the secret.</summary>
    internal ActionError CredentialSaveError(SqlException error, SqlConnection? connection, string? secret)
    {
        var errors = error.Errors.Cast<SqlError>().ToList();
        var first = errors.FirstOrDefault(item => item.Class > 10)?.Number ?? error.Number;
        if (first == 50011) return Error("STALE", AgentSql.StaleMessage);
        var mapped = ActionErrors.FromSql(catalog, error, connection, ddl: true, null);
        var text = CredentialSql.Scrub(string.Join(" ", errors.Where(item => item.Class > 10 && item.Number is not (3621 or 3998)).Select(item => item.Message).Distinct()), secret);
        return ActionErrors.Create(catalog, mapped.Code, text.Length > 0 ? text : "SQL Server did not save the credential.") with { Field = mapped.Code == "NAME_IN_USE" ? "name" : null, Retryable = mapped.Retryable };
    }

    /// <summary>The save's script: the statement in master, the secret <see cref="CredentialSql.Placeholder"/>.</summary>
    internal static string CredentialScript(ActionArgs args, ObjectRefDto target)
    {
        var save = args.Credential!;
        var create = target.Kind == "server";
        return "USE [master]\nGO\n" + CredentialSql.ScriptStatement(create, create ? save.Name! : target.Name!, save.Identity, save.Provider) + "\nGO\n";
    }

    private Task<ActionScriptResult> ScriptCredential(ActionArgs args, ObjectRefDto target)
    {
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (!Serves(args.Action, engine)) return Task.FromResult(new ActionScriptResult(null, "master", [], Error("NOT_SUPPORTED", EngineMessage(engine))));
        return Task.FromResult(new ActionScriptResult(CredentialScript(args, target), "master", []));
    }
}
