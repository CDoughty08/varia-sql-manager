using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>New Login (D2a, D2b): its describe and User Mapping's read of a database, Script Action and run. The run follows SSMS's order without a transaction (owner
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
    /// <summary>Joined when a User Mapping statement (a user, its default schema or schema, a database role) did not complete.</summary>
    internal const string LoginMappingsMessage = "Not every database was mapped as chosen.";
    /// <summary>User Mapping's steps, whose detail names their database.</summary>
    private static bool MappingStep(ActionTemplate template) => template is ActionTemplate.CreateUserForLogin or ActionTemplate.AlterUserSchema or ActionTemplate.CreateSchemaFor or ActionTemplate.AddRoleMember
        or ActionTemplate.RenameUser or ActionTemplate.DropRoleMember;
    private static bool SameMembers(ActionArgs args) => args.NewName is null && args.CloseConnections is null && args.DeleteHistory is null && args.Changes is null && args.Design is null
        && args.Identity is null;
    /// <summary>Whether a request carries New Login's members, which only createLogin takes.</summary>
    private static bool LoginMembers(ActionArgs args) => args.Login is not null || args.ServerRoles is not null || args.Status is not null || args.Mappings is not null;

    /// <summary>A database ref (kind database, a name, no other member), which User Mapping's read takes.</summary>
    private ObjectRefDto MappedDatabase(ObjectRefDto? target)
    {
        if (target is not { Kind: "database", Database: null, Schema: null, Parent: null, SsisFolder: null, SsisProject: null } || !ExplorerRefs.Ident(target.Name)) throw Invalid("target.");
        try { ExplorerRefs.Object(target, explorer); }
        catch (RequestException) { throw Invalid("target."); }
        return target;
    }

    /// <summary>The server ref New Login names as its target, with no other member.</summary>
    private static ObjectRefDto ServerTarget(ObjectRefDto? target) =>
        target is { Kind: "server", Database: null, Schema: null, Name: null, Parent: null, SsisFolder: null, SsisProject: null } ? target : throw Invalid("target.");

    /// <summary>Re-validates createLoginSchema (src/shared/actions/schema.ts) and, on execute, actionExecuteRequestSchema's secrets:
    /// a Windows login named DOMAIN\name without password options, or a SQL Server login without a backslash, with the options in
    /// SQL Server's chain; names of at most 128 UTF-16 units without U+0000; distinct server roles other than public; mappings of
    /// distinct databases, each with a user, an optional default schema and distinct roles other than public; at most
    /// actionLimits.statements statements in all; a Status; and the password exactly for a SQL Server login (blank only with the
    /// password policy on). Messages name members, never values.</summary>
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
        if (args.Status is not { Connect: "grant" or "deny" } status) throw Invalid("status.");
        if (args.Mappings is not { } mappings || mappings.Count > catalog.Logins.Limit("mappings") || mappings.Select(mapping => mapping?.Database).Distinct(StringComparer.Ordinal).Count() != mappings.Count)
            throw Invalid("mappings.");
        foreach (var mapping in mappings)
            if (mapping is null || !ExplorerRefs.Ident(mapping.Database) || !ExplorerRefs.Ident(mapping.User) || (mapping.DefaultSchema is not null && !ExplorerRefs.Ident(mapping.DefaultSchema))
                || mapping.RolesAdd is not { } added || added.Count > catalog.Logins.Limit("roles") || added.Any(role => !ExplorerRefs.Ident(role) || role == "public")
                || added.Distinct(StringComparer.Ordinal).Count() != added.Count)
                throw Invalid("mappings.");
        if (LoginSql.Statements(status, roles, mappings) > catalog.Limit("statements")) throw Invalid("mappings: too many statements.");
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
            while (await reader.ReadAsync(token)) listed.Add(new(reader.GetString(0), Convert.ToInt32(reader.GetValue(1), System.Globalization.CultureInfo.InvariantCulture), reader.GetBoolean(2), reader.GetBoolean(3)));
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

    /// <summary>User Mapping's read of one database (the loginDatabaseRoles describe): its state in master, then its roles, guest's
    /// CONNECT and its schemas inside it, through the database's own module (ActionSql.ModuleCall). With <paramref name="login"/>
    /// (Login Properties, D2c), also the user mapped to that login there and the roles it is a member of.</summary>
    private async Task<ActionDescribeResult> DescribeDatabaseRolesJobAsync(SqlConnection connection, ObjectRefDto target, CancellationToken token, string? login = null)
    {
        var database = target.Name!;
        if (await DatabaseUnavailableAsync(connection, database, token) is { } unavailable) return new(null, 0, unavailable);
        var roles = (int)catalog.Logins.Limit("roles");
        var schemas = (int)catalog.Logins.Limit("schemas");
        await using var command = ModuleCommand(connection, database, LoginSql.DatabaseRoles, null, null, Math.Max(roles, schemas) + 1);
        await using var reader = await command.ExecuteReaderAsync(token);
        var listed = new List<string>();
        while (await reader.ReadAsync(token)) listed.Add(reader.GetString(0));
        var guest = false;
        if (await reader.NextResultAsync(token) && await reader.ReadAsync(token)) guest = reader.GetBoolean(0);
        var names = new List<string>();
        if (await reader.NextResultAsync(token)) while (await reader.ReadAsync(token)) names.Add(reader.GetString(0));
        await reader.DisposeAsync();
        var model = new LoginDatabaseRolesDto([.. listed.Take(roles)], listed.Count > roles, guest, [.. names.Take(schemas)], names.Count > schemas);
        if (login is null) return new(null, 0, LoginDatabaseRoles: model);
        var (user, memberOf, error) = await DatabaseUserAsync(connection, database, login, roles + 1, token);
        if (error is not null) return new(null, 0, error);
        return new(null, 0, LoginDatabaseRoles: model with { User = user, MemberOf = [.. memberOf.Take(roles)] });
    }

    /// <summary>A command that runs <paramref name="statement"/> inside <paramref name="database"/> (ActionSql.ModuleCall), with
    /// @name, @schema and @take as its parameters.</summary>
    private static SqlCommand ModuleCommand(SqlConnection connection, string database, string statement, string? name, string? schema, int take)
    {
        var command = connection.CreateCommand();
        command.CommandText = ActionSql.ModuleCall;
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, database);
        Add(command, "@stmt", SqlDbType.NVarChar, -1, statement);
        Add(command, "@decl", SqlDbType.NVarChar, -1, ActionSql.Declarations);
        Add(command, "@schema", SqlDbType.NVarChar, 128, schema);
        Add(command, "@name", SqlDbType.NVarChar, 128, name);
        Add(command, "@new", SqlDbType.NVarChar, 128, null);
        Add(command, "@take", SqlDbType.Int, 0, take);
        return command;
    }

    /// <summary>Why a database cannot be mapped or read, as master sees it (ActionSql.DatabaseState): gone, not online, not open to
    /// this login, or read-only (CREATE USER would fail with 3906 after CREATE LOGIN had run); null when it can.</summary>
    private async Task<ActionError?> DatabaseUnavailableAsync(SqlConnection connection, string database, CancellationToken token)
    {
        await using var state = connection.CreateCommand();
        state.CommandText = ActionSql.DatabaseState;
        state.CommandTimeout = 0;
        Add(state, "@db", SqlDbType.NVarChar, 128, database);
        await using var reader = await state.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return Error("NOT_FOUND", "The database " + ScriptingErrors.Display(database) + " no longer exists. Refresh Object Explorer.");
        var facts = ReadRow(reader);
        if (facts.Int("state") != 0 || !facts.Bool("has_access"))
            return Error("DATABASE_UNAVAILABLE", "The database " + ScriptingErrors.Display(database) + " is " + (facts.Int("state") != 0 ? (facts.Text("state_desc") ?? "unavailable").ToLowerInvariant() : "not accessible to this login") + ", so it cannot be mapped.");
        if (facts.Bool("read_only")) return Error("DATABASE_UNAVAILABLE", "The database " + ScriptingErrors.Display(database) + " is read-only, so it cannot be mapped.");
        return null;
    }

    /// <summary>User Mapping's preflight, per mapped database in the plan's order, before anything runs: the database is there, online
    /// and open to this login; when <paramref name="refuse"/> (OK, not Script), no user or role has the user's name and every role
    /// chosen exists (when the role list is not cut short). Answers the databases whose default schema is missing, which get a
    /// CREATE SCHEMA step, or the first refusal.</summary>
    private async Task<(HashSet<string> MissingSchemas, ActionError? Error)> MappingPreflightAsync(SqlConnection connection, IReadOnlyList<UserMappingDto> mappings, bool refuse, CancellationToken token)
    {
        var missing = new HashSet<string>(StringComparer.Ordinal);
        var take = (int)catalog.Logins.Limit("roles");
        foreach (var database in LoginSql.Ordered(mappings.Select(mapping => mapping.Database)))
        {
            var mapping = mappings.First(item => item.Database == database);
            if (await DatabaseUnavailableAsync(connection, database, token) is { } unavailable) return (missing, unavailable);
            if (!refuse && mapping.DefaultSchema is null) continue;
            await using var command = ModuleCommand(connection, database, LoginSql.MappingPreflight, mapping.User, mapping.DefaultSchema, take + 1);
            await using var reader = await command.ExecuteReaderAsync(token);
            if (!await reader.ReadAsync(token)) continue;
            var row = ReadRow(reader);
            if (!row.Bool("schema_exists")) missing.Add(database);
            if (!refuse) continue;
            if (row.Bool("user_in_use"))
                return (missing, Error("NAME_IN_USE", "The database " + ScriptingErrors.Display(database) + " already has a user or role named " + ScriptingErrors.Display(mapping.User) + "."));
            var roles = new List<string>();
            if (await reader.NextResultAsync(token)) while (await reader.ReadAsync(token)) roles.Add(reader.GetString(0));
            // A server's collation may match names case-insensitively, as SQL Server will; only a role in no form is refused, and
            // none when the list was cut short.
            if (roles.Count <= take && LoginSql.Ordered(mapping.RolesAdd).FirstOrDefault(role => !roles.Contains(role, StringComparer.OrdinalIgnoreCase)) is { } absent)
                return (missing, Error("NOT_FOUND", "The database " + ScriptingErrors.Display(database) + " has no role named " + ScriptingErrors.Display(absent) + "."));
        }
        return (missing, null);
    }

    /// <summary>Script Action: built from the request alone, as SSMS's Script runs nothing; the password is the placeholder. Only a
    /// default schema needs the server: whether the database has it decides SSMS's CREATE SCHEMA, read on a read connection.</summary>
    private Task<ActionScriptResult> ScriptNewLoginAsync(ActionArgs args, CancellationToken token)
    {
        var served = host.Profile(args.ConnectionId).Explorer(explorer);
        if (!Serves(args.Action, served.ServerEngine)) return Task.FromResult(new ActionScriptResult(null, "master", [], ActionErrors.Create(catalog, "NOT_SUPPORTED", EngineMessage(served.ServerEngine))));
        ActionScriptResult Script(IReadOnlySet<string> missing)
        {
            var text = LoginSql.ScriptText(args.Login!, args.ServerRoles!, args.Status!, args.Mappings!, missing, catalog.Logins.ScriptHeader);
            return text.Length > ScriptLimit(args.Action) ? new(null, "master", [], Error("SQL_ERROR", "The script is too large.")) : new(text, "master", []);
        }
        if (!args.Mappings!.Any(mapping => mapping.DefaultSchema is not null)) return Task.FromResult(Script(new HashSet<string>()));
        return RunAsync(args.ConnectionId, args.RequestId, args.Action, read: true, Options.ScriptBudget, token,
            async (connection, profile, band, job) =>
            {
                var (missing, error) = await MappingPreflightAsync(connection, args.Mappings!, refuse: false, job);
                return error is null ? Script(missing) : new ActionScriptResult(null, "master", [], error);
            },
            error => new ActionScriptResult(null, "master", [], error));
    }

    /// <summary>OK: the preflight (the name, and ALTER ANY LOGIN; then each mapped database's), then CREATE LOGIN and the statements
    /// after it, one by one in SSMS's order. What SQL Server says is scrubbed of the password; Varia's own sentences are not.</summary>
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
        var (missing, refused) = await MappingPreflightAsync(connection, args.Mappings!, refuse: true, token);
        if (refused is not null) return new([], [], 0, refused);
        var secrets = args.Secrets;
        string Scrubbed(string text) => LoginSql.Scrub(text, secrets);
        var steps = new List<RunStep> { new(CreateLoginStep, context => CreateLoginAsync(connection, login, secrets?.Password, dryRun: false, context.Token)) };
        steps.AddRange(LoginSql.After(login, args.ServerRoles!, args.Status!).Concat(LoginSql.Mappings(login, args.Mappings!, missing)).Select(ActionSql.Checked).Select(statement =>
            new RunStep(StepTitle(statement.Template), context => RunStatementAsync(connection, statement, dryRun: false, context.Token), Detail: StepDetail(statement))));
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
    /// enabled against the Status chosen, whether a server role is missing, and whether a database is not mapped as chosen), so a clip
    /// cuts the list of completed steps, never that.</summary>
    internal static ActionError PartlyCreated(ActionError failure, LoginStatusDto status, IReadOnlyList<ActionStepDto> steps)
    {
        bool Done(string title) => steps.Any(step => step.Title == title && step.Status == "done");
        var state = LoginCreatedMessage;
        if (status.Connect == "deny" && !Done(StepTitle(ActionTemplate.DenyConnect))) state += " " + LoginCanConnectMessage;
        if (!status.Enabled && !Done(StepTitle(ActionTemplate.DisableLogin))) state += " " + LoginEnabledMessage;
        if (steps.Any(step => step.Title == StepTitle(ActionTemplate.AddServerRoleMember) && step.Status != "done")) state += " " + LoginRolesMessage;
        var mapping = new[] { ActionTemplate.CreateUserForLogin, ActionTemplate.AlterUserSchema, ActionTemplate.CreateSchemaFor, ActionTemplate.AddRoleMember }.Select(StepTitle).ToHashSet(StringComparer.Ordinal);
        if (steps.Any(step => mapping.Contains(step.Title) && step.Status != "done")) state += " " + LoginMappingsMessage;
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
