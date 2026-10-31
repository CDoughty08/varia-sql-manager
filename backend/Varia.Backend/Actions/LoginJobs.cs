using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>New Login (D2a): its describe, Script Action and run. The run follows SSMS's order without a transaction (owner
/// decision 6's fallback, critic A24): on SQL Server 2025, an open transaction holding a CREATE LOGIN kept logins whose security
/// token was not cached (a first sign-in) from signing in until it ended, and one holding a server role membership change kept
/// every SQL Server login out, so a statement waiting for a lock would lock users out. A failure or Stop therefore leaves what
/// completed, and the reply starts with the login's real state. The password is bound only as @password and scrubbed from SQL
/// Server's text, never from Varia's own sentences.</summary>
internal sealed partial class ActionService
{
    internal const string CreateLoginStep = "Create the login";
    /// <summary>Starts the message of a failure or Stop after the login was created: the statements run one by one, as in SSMS.</summary>
    internal const string LoginCreatedMessage = "The login was created, but the steps after it did not all complete.";
    /// <summary>Joined when Deny was chosen and DENY CONNECT SQL did not complete.</summary>
    internal const string LoginCanConnectMessage = "It can connect: permission to connect was not denied.";
    /// <summary>Joined when Disabled was chosen and DISABLE did not complete.</summary>
    internal const string LoginEnabledMessage = "It is enabled.";
    /// <summary>Joined when a server role was not added.</summary>
    internal const string LoginRolesMessage = "Not every server role was added.";
    private static bool SameMembers(ActionArgs args) => args.NewName is null && args.CloseConnections is null && args.DeleteHistory is null && args.Changes is null && args.Design is null
        && args.Identity is null;
    /// <summary>Whether a request carries New Login's members, which only createLogin takes.</summary>
    private static bool LoginMembers(ActionArgs args) => args.Login is not null || args.ServerRoles is not null || args.Status is not null;

    /// <summary>The server ref New Login names as its target, with no other member.</summary>
    private static ObjectRefDto ServerTarget(ObjectRefDto? target) =>
        target is { Kind: "server", Database: null, Schema: null, Name: null, Parent: null, SsisFolder: null, SsisProject: null } ? target : throw Invalid("target.");

    /// <summary>Re-validates createLoginSchema (src/shared/actions/schema.ts) and, on execute, actionExecuteRequestSchema's secrets:
    /// a Windows login named DOMAIN\name without password options, or a SQL Server login without a backslash, with the options in
    /// SQL Server's chain; names of at most 128 UTF-16 units without U+0000; distinct server roles other than public; a Status;
    /// and the password exactly for a SQL Server login (blank only with the password policy on). Messages name members, never values.</summary>
    private ObjectRefDto ValidateCreateLogin(ActionArgs args, bool script)
    {
        if (!SameMembers(args)) throw Invalid("createLogin takes a login, server roles and a status only.");
        var target = ServerTarget(args.Target);
        if (args.Login is not { } login || !ExplorerRefs.Ident(login.Name) || !ExplorerRefs.Ident(login.DefaultDatabase) || (login.DefaultLanguage is not null && !ExplorerRefs.Ident(login.DefaultLanguage)))
            throw Invalid("login.");
        switch (login.Auth)
        {
            case "sql":
                if (login.CheckPolicy is not { } policy || login.CheckExpiration is not { } expiration || login.MustChange is not { } mustChange) throw Invalid("login options.");
                if ((expiration && !policy) || (mustChange && !expiration)) throw Invalid("login options.");
                if (login.Name.Contains('\\', StringComparison.Ordinal)) throw Invalid("login name.");
                break;
            case "windows":
                if (login.CheckPolicy is not null || login.CheckExpiration is not null || login.MustChange is not null) throw Invalid("login options.");
                var slash = login.Name.IndexOf('\\', StringComparison.Ordinal);
                if (slash <= 0 || slash == login.Name.Length - 1 || login.Name.IndexOf('\\', slash + 1) >= 0) throw Invalid("login name.");
                break;
            default:
                throw Invalid("login auth.");
        }
        if (args.ServerRoles is not { } roles || roles.Count > catalog.Logins.Limit("serverRoles") || roles.Any(role => !ExplorerRefs.Ident(role) || role == "public")
            || roles.Distinct(StringComparer.Ordinal).Count() != roles.Count)
            throw Invalid("serverRoles.");
        if (args.Status is not { Connect: "grant" or "deny" }) throw Invalid("status.");
        if (script) return target;
        if (login.Auth == "sql" ? args.Secrets is not { Password: not null, OldPassword: null } : args.Secrets is not null) throw Invalid("secrets.");
        if (login.Auth == "sql" && args.Secrets!.Password!.Length == 0 && login.CheckPolicy != true) throw Invalid("secrets.password.");
        return target;
    }

    /// <summary>New Login's lists and the server's facts, read in master on the describe's own connection.</summary>
    private async Task<ActionDescribeResult> DescribeNewLoginJobAsync(SqlConnection connection, ServerProfile profile, int band, CancellationToken token)
    {
        var databases = (int)catalog.Logins.Limit("databases");
        var languages = (int)catalog.Logins.Limit("languages");
        var roles = (int)catalog.Logins.Limit("serverRoles");
        await using var command = connection.CreateCommand();
        command.CommandText = LoginSql.Describe;
        command.CommandTimeout = 0;
        Add(command, "@databases", SqlDbType.Int, 0, databases + 1);
        Add(command, "@languages", SqlDbType.Int, 0, languages);
        Add(command, "@roles", SqlDbType.Int, 0, roles + 1);
        await using var reader = await command.ExecuteReaderAsync(token);
        var windowsOnly = false;
        var canCreate = true;
        if (await reader.ReadAsync(token)) { windowsOnly = reader.GetBoolean(0); canCreate = reader.GetBoolean(1); }
        var listed = new List<NewLoginDatabaseDto>();
        if (await reader.NextResultAsync(token))
            while (await reader.ReadAsync(token)) listed.Add(new(reader.GetString(0), Convert.ToInt32(reader.GetValue(1), System.Globalization.CultureInfo.InvariantCulture), reader.GetBoolean(2)));
        var names = new List<NewLoginLanguageDto>();
        if (await reader.NextResultAsync(token))
            while (await reader.ReadAsync(token)) names.Add(new(reader.GetString(0), reader.IsDBNull(1) ? "" : reader.GetString(1)));
        var serverRoles = new List<NewLoginServerRoleDto>();
        if (await reader.NextResultAsync(token))
            while (await reader.ReadAsync(token)) serverRoles.Add(new(reader.GetString(0), reader.GetBoolean(1)));
        var model = new NewLoginModelDto(new(band, profile.Linux, windowsOnly, canCreate), [.. listed.Take(databases)], listed.Count > databases, names,
            [.. serverRoles.Take(roles)], serverRoles.Count > roles);
        return new(null, 0, NewLogin: model);
    }

    /// <summary>Script Action: built from the request alone, as SSMS's Script runs nothing; the password is the placeholder.</summary>
    private ActionScriptResult ScriptNewLogin(ActionArgs args)
    {
        var served = host.Profile(args.ConnectionId).Explorer(explorer);
        if (!Serves(args.Action, served.ServerEngine)) return new(null, "master", [], ActionErrors.Create(catalog, "NOT_SUPPORTED", EngineMessage(served.ServerEngine)));
        var text = LoginSql.ScriptText(args.Login!, args.ServerRoles!, args.Status!, catalog.Logins.ScriptHeader);
        return text.Length > ScriptLimit(args.Action) ? new(null, "master", [], Error("SQL_ERROR", "The script is too large.")) : new(text, "master", []);
    }

    /// <summary>OK: the preflight (the name, and ALTER ANY LOGIN), then CREATE LOGIN and the statements after it, one by one in
    /// SSMS's order. What SQL Server says is scrubbed of the password; Varia's own sentences are not.</summary>
    private async Task<ActionExecuteResult> ExecuteNewLoginJobAsync(SqlConnection connection, ActionArgs args, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        var login = args.Login!;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = LoginSql.Preflight;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, login.Name);
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token))
            {
                if (reader.GetBoolean(0)) return new([], [], 0, Error("NAME_IN_USE", "The name " + ScriptingErrors.Display(login.Name) + " is already used by a login or a server role."));
                if (!reader.GetBoolean(1)) return new([], [], 0, Error("PERMISSION_DENIED", "You do not have permission to create logins (ALTER ANY LOGIN)."));
            }
        }
        var secrets = args.Secrets;
        string Scrubbed(string text) => LoginSql.Scrub(text, secrets);
        var steps = new List<RunStep> { new(CreateLoginStep, context => CreateLoginAsync(connection, login, secrets?.Password, dryRun: false, context.Token)) };
        steps.AddRange(LoginSql.After(login, args.ServerRoles!, args.Status!).Select(statement => new RunStep(StepTitle(statement.Template),
            context => RunStatementAsync(connection, statement, dryRun: false, context.Token), Detail: statement.Template == ActionTemplate.AddServerRoleMember ? statement.Names[0] : null)));
        var (done, failure, _) = await RunStepsAsync(connection, steps, null, token, CleanupBudget(args.Action), serverText: Scrubbed);
        if (failure is not null && done is [{ Status: "cancelled" }, ..])
        {
            // A Stop that reached SqlClient as CREATE LOGIN finished on the server: the login may exist although the step says
            // cancelled. The preflight's own statement tells, within the cleanup budget; a connection Stop broke leaves it unknown.
            try
            {
                using var budget = new CancellationTokenSource(CleanupBudget(args.Action));
                await using var command = connection.CreateCommand();
                command.CommandText = LoginSql.Preflight;
                Add(command, "@name", SqlDbType.NVarChar, 128, login.Name);
                if (await command.ExecuteScalarAsync(budget.Token) is true) (done, failure) = StoppedAsCreated(done, failure);
            }
            catch (Exception exception) when (exception is SqlException or InvalidOperationException or OperationCanceledException) { }
        }
        if (failure is not null && done is [{ Status: "done" }, ..]) failure = PartlyCreated(failure, args.Status!, done);
        return new(done, [.. messages.Collected().Select(Scrubbed)], 0, failure);
    }

    /// <summary>A Stop whose CREATE LOGIN completed after all (the login exists): that step is done, and the message says nothing
    /// after it ran.</summary>
    internal static (List<ActionStepDto> Steps, ActionError Failure) StoppedAsCreated(List<ActionStepDto> steps, ActionError failure) =>
        ([steps[0] with { Status = "done" }, .. steps.Skip(1)], failure with { Message = "The action was stopped as \"" + CreateLoginStep + "\" completed; nothing after it ran." });

    /// <summary>A failure or Stop after CREATE LOGIN: the message starts with the login's real state (whether it can connect or is
    /// enabled against the Status chosen, and whether a server role is missing), so a clip cuts the list of completed steps, never that.</summary>
    internal static ActionError PartlyCreated(ActionError failure, LoginStatusDto status, IReadOnlyList<ActionStepDto> steps)
    {
        bool Done(string title) => steps.Any(step => step.Title == title && step.Status == "done");
        var state = LoginCreatedMessage;
        if (status.Connect == "deny" && !Done(StepTitle(ActionTemplate.DenyConnect))) state += " " + LoginCanConnectMessage;
        if (!status.Enabled && !Done(StepTitle(ActionTemplate.DisableLogin))) state += " " + LoginEnabledMessage;
        if (steps.Any(step => step.Title == StepTitle(ActionTemplate.AddServerRoleMember) && step.Status != "done")) state += " " + LoginRolesMessage;
        return failure with { Message = ScriptingErrors.Clip(state + " " + failure.Message, ActionErrors.MaxMessage) };
    }

    /// <summary>Runs (or, for the live checks, dry-runs) the CREATE LOGIN batch. The password is one nvarchar(128) parameter,
    /// cleared once the batch ends.</summary>
    private static async Task<List<string?>> CreateLoginAsync(SqlConnection connection, NewLoginDto login, string? password, bool dryRun, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = LoginSql.CreateExecutable(login, dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, "master");
        Add(command, "@p1", SqlDbType.NVarChar, 128, login.Name);
        Add(command, "@p2", SqlDbType.NVarChar, 128, login.DefaultDatabase);
        if (login.DefaultLanguage is { } language) Add(command, "@p3", SqlDbType.NVarChar, 128, language);
        var secret = login.Auth == "sql" ? new SqlParameter("@password", SqlDbType.NVarChar, 128) { Value = (object?)password ?? DBNull.Value } : null;
        if (secret is not null) command.Parameters.Add(secret);
        try
        {
            var values = new List<string?>();
            await using var reader = await command.ExecuteReaderAsync(token);
            do
            {
                while (await reader.ReadAsync(token))
                    for (var i = 0; i < reader.FieldCount; i++) values.Add(reader.IsDBNull(i) ? null : reader.GetString(i));
            } while (await reader.NextResultAsync(token));
            return values;
        }
        finally { if (secret is not null) secret.Value = DBNull.Value; }
    }

    /// <summary>The live checks' only way to see the CREATE LOGIN statement SQL Server would build for a login and a throwaway
    /// password (see the other DryRunAsync). Not reachable from the wire.</summary>
    internal async Task<string?> DryRunCreateLoginAsync(string connectionId, NewLoginDto login, string? password, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        return (await CreateLoginAsync(connection, login, password, dryRun: true, token)).SingleOrDefault();
    }
}
