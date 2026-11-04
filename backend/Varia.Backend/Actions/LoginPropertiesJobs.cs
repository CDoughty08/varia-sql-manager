using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Login Properties (D2c): its describe (the login's facts, defaults and server roles, its lock-out state through the one
/// LOGINPROPERTY reader, New Login's lists, and the users mapped to it through D4c's per-database scan), Script Action and run.
/// The run follows SSMS's order without a transaction, as New Login's does (owner decision 6's fallback, critic A24): the options,
/// the password, Connect, Enabled, the server roles, then each changed database. A failure or Stop leaves what completed, and the
/// steps say what that is. Passwords are bound only as @password and @old_password and scrubbed from SQL Server's text.</summary>
internal sealed partial class ActionService
{
    internal const string LoginOptionsStep = "Change the login's options";
    internal const string LoginPasswordStep = "Change the password";
    /// <summary>Starts the message of a failure or Stop after a step completed: the statements run one by one, as in SSMS.</summary>
    internal const string LoginChangedMessage = "The login was changed only in part: its steps run one by one, as in SSMS, and list what completed.";

    /// <summary>Re-validates loginPropertiesSchema (src/shared/actions/schema.ts) and, on execute, its identity and secrets: a login
    /// target that offers Properties; only the changed options (names of at most 128 UTF-16 units; CHECK_EXPIRATION ON never with
    /// CHECK_POLICY OFF); a password change whose old password excludes UNLOCK and MUST_CHANGE; distinct server roles other than public
    /// to add or drop, never both; mappings of distinct databases (map: a user, a schema, roles to add; unmap: the user only; update:
    /// at least one change, a new name that differs); Connect grant or deny; between one and actionLimits.statements statements;
    /// and on execute the identity the dialog read, and the new password exactly when the changes set one (the old one exactly when
    /// they say so). Messages name members, never values.</summary>
    private ObjectRefDto ValidateLoginProperties(ActionArgs args, bool script)
    {
        if (!SameMembers(args) || args.DropMappedUsers is not null || args.Mode is not null) throw Invalid("loginProperties takes a target, the login's identity and its changes only.");
        var target = Target(args.Target, "loginProperties");
        if (args.LoginChanges is not { } changes) throw Invalid("loginChanges.");
        static bool Name(string? value) => value is null || ExplorerRefs.Ident(value);
        if (!Name(changes.DefaultDatabase) || !Name(changes.DefaultLanguage)) throw Invalid("loginChanges.defaults.");
        if (changes.CheckExpiration == true && changes.CheckPolicy == false) throw Invalid("loginChanges.options.");
        if (changes.Password is { OldPassword: true, Unlock: true } or { OldPassword: true, MustChange: true }) throw Invalid("loginChanges.password.");
        if (changes.Connect is not (null or "grant" or "deny")) throw Invalid("loginChanges.connect.");
        List<string> Roles(List<string>? roles, string key, string member)
        {
            if (roles is null) return [];
            if (roles.Count > catalog.Logins.Limit(key) || roles.Any(role => !ExplorerRefs.Ident(role) || role == "public") || roles.Distinct(StringComparer.Ordinal).Count() != roles.Count)
                throw Invalid(member);
            return roles;
        }
        if (Roles(changes.RolesAdd, "serverRoles", "loginChanges.rolesAdd.").Intersect(Roles(changes.RolesDrop, "serverRoles", "loginChanges.rolesDrop."), StringComparer.Ordinal).Any())
            throw Invalid("loginChanges.roles.");
        var mappings = changes.Mappings ?? [];
        if (mappings.Count > catalog.Logins.Limit("mappings") || mappings.Select(mapping => mapping?.Database).Distinct(StringComparer.Ordinal).Count() != mappings.Count)
            throw Invalid("loginChanges.mappings.");
        foreach (var mapping in mappings)
        {
            if (mapping is null || !ExplorerRefs.Ident(mapping.Database) || !ExplorerRefs.Ident(mapping.User) || !Name(mapping.NewName) || !Name(mapping.DefaultSchema)) throw Invalid("loginChanges.mappings.");
            var added = Roles(mapping.RolesAdd, "roles", "loginChanges.mappings.");
            var dropped = Roles(mapping.RolesDrop, "roles", "loginChanges.mappings.");
            if (added.Intersect(dropped, StringComparer.Ordinal).Any()) throw Invalid("loginChanges.mappings.");
            var valid = mapping.Change switch
            {
                "unmap" => mapping.NewName is null && mapping.DefaultSchema is null && mapping.RolesAdd is null && mapping.RolesDrop is null,
                "map" => mapping.NewName is null && mapping.RolesDrop is null,
                "update" => (mapping.NewName is null || !string.Equals(mapping.NewName, mapping.User, StringComparison.Ordinal))
                    && (mapping.NewName is not null || mapping.DefaultSchema is not null || added.Count > 0 || dropped.Count > 0),
                _ => false
            };
            if (!valid) throw Invalid("loginChanges.mappings.");
        }
        if (PermissionSql.Problem(catalog.Logins.Securables, changes.Permissions, create: false, catalog.Logins.Limit("permissions")) is { } problem) throw Invalid("loginChanges." + problem);
        var statements = LoginSql.PropertiesStatements(changes);
        if (statements == 0) throw Invalid("loginChanges: nothing changes.");
        if (statements > catalog.Limit("statements")) throw Invalid("loginChanges: too many statements.");
        if (script) return target;
        if (args.LoginIdentity is null) throw Invalid("a login's properties need the loginIdentity it read.");
        var secretsValid = changes.Password is { } password
            ? args.Secrets is { Password: { Length: > 0 } } secrets && (password.OldPassword ? secrets.OldPassword is not null : secrets.OldPassword is null)
            : args.Secrets is null;
        if (!secretsValid) throw Invalid("secrets.");
        return target;
    }

    /// <summary>Login Properties' describe, in master on the describe's own connection: the login's facts (ActionSql.LoginAlter, which
    /// reads nothing it owns), its default database and language and server roles (LoginSql.PropertiesRead), a SQL Server login's
    /// lock-out state (ActionSql.LoginLock, critic A15), New Login's lists, the users mapped to it in each database this connection
    /// may read, within the scan's budget (a database it did not read is listed as not read), and, for a Windows login, the services
    /// that run as it (ActionSql.LoginService).</summary>
    private async Task<ActionDescribeResult> DescribeLoginPropertiesJobAsync(SqlConnection connection, ServerProfile profile, ObjectRefDto target, int band, CancellationToken token)
    {
        var (facts, row) = await LoginAsync(connection, target.Name!, null, null, token);
        if (facts is null) return new(null, 0, Error("NOT_FOUND", "The login " + Display(target) + " no longer exists. Refresh Object Explorer."));
        var limit = (int)catalog.Logins.Limit("serverRoles");
        var defaultDatabase = "master";
        string? language = null;
        var roles = new List<string>();
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = LoginSql.PropertiesRead;
            command.CommandTimeout = 0;
            Add(command, "@principal", SqlDbType.Int, 0, facts.PrincipalId);
            Add(command, "@roles", SqlDbType.Int, 0, limit + 1);
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token))
            {
                if (!reader.IsDBNull(0)) defaultDatabase = reader.GetString(0);
                if (!reader.IsDBNull(1)) language = reader.GetString(1);
            }
            if (await reader.NextResultAsync(token))
                while (await reader.ReadAsync(token)) roles.Add(reader.GetString(0));
        }
        var state = facts.Type.Trim() == "S" ? await LoginLockAsync(connection, row!.Text("name") ?? target.Name!, token) : null;
        var model = (await DescribeNewLoginJobAsync(connection, profile, band, token)).NewLogin;
        var (users, _, databases, _) = await ScanAsync(connection, SidBytes(facts), LoginSql.PropertiesMappedUser, (int)catalog.Logins.Limit("databases"), ScanBudget, token,
            (database, _, _, reader) => new LoginMappedUserDto(database, reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.GetBoolean(2)));
        var read = databases.Where(database => database.Checked).Select(database => database.Name).ToList();
        // Status' Disabled or Deny asks first when a service runs as the login (loginStatusConfirm), as the loginFacts describe
        // tells Disable; without it the prompt could never name the service.
        var service = facts.Type.Trim() == "U" ? await LoginServiceAsync(connection, row!.Text("name") ?? target.Name!, token) : null;
        // SQL Server's own logins never change here, so their Securables page reads nothing (SSMS's SecurablePermissions = null).
        var (permissions, permissionsTruncated) = facts.Subtype == "system" ? (new List<ExplicitPermissionDto>(), false) : await ExplicitPermissionsAsync(connection, facts.PrincipalId, token);
        return new(null, 0, NewLogin: model, Login: facts with { Service = service }, Lock: state,
            LoginProperties: new(defaultDatabase, language, [.. roles.Take(limit)], roles.Count > limit, users, read, permissions, permissionsTruncated));
    }

    /// <summary>The user mapped to a login in one database and that user's roles (LoginSql.DatabaseUser, through ActionSql.MappedUserCall),
    /// for Login Properties' User Mapping; NOT_FOUND when the login is gone.</summary>
    private async Task<(LoginDatabaseUserDto? User, List<string> MemberOf, ActionError? Error)> DatabaseUserAsync(SqlConnection connection, string database, string login, int take, CancellationToken token)
    {
        byte[]? sid;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = LoginSql.LoginSid;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, login);
            // A reader, as every action statement runs (tests/action-reader-lint.test.ts).
            await using var found = await command.ExecuteReaderAsync(token);
            sid = await found.ReadAsync(token) && !found.IsDBNull(0) ? (byte[])found.GetValue(0) : null;
        }
        if (sid is null) return (null, [], Error("NOT_FOUND", "The login " + ScriptingErrors.Display(login) + " no longer exists. Refresh Object Explorer."));
        await using var read = connection.CreateCommand();
        read.CommandText = ActionSql.MappedUserCall;
        read.CommandTimeout = 0;
        Add(read, "@db", SqlDbType.NVarChar, 128, database);
        Add(read, "@stmt", SqlDbType.NVarChar, -1, LoginSql.DatabaseUser);
        Add(read, "@sid", SqlDbType.VarBinary, 85, sid);
        Add(read, "@take", SqlDbType.Int, 0, take);
        await using var reader = await read.ExecuteReaderAsync(token);
        LoginDatabaseUserDto? user = null;
        if (await reader.ReadAsync(token)) user = new(reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.GetBoolean(2));
        var memberOf = new List<string>();
        if (await reader.NextResultAsync(token)) while (await reader.ReadAsync(token)) memberOf.Add(reader.GetString(0));
        return (user, memberOf, null);
    }

    /// <summary>Why Login Properties refuses to run for the login its preflight read, or null: a login the request's identity does not
    /// describe, then logins.ts loginPropertiesRefusal's rules (LoginRules.PropertiesRefusal). Permissions are left to SQL Server: a
    /// login may change its own password (with the old one), default database and language without ALTER ANY LOGIN.</summary>
    internal ActionError? LoginPropertiesRefusal(LoginFactsDto login, ActionArgs args)
    {
        if (IdentityRefusal(login, args) is { } changed) return changed;
        return LoginRules.PropertiesRefusal(login, args.LoginChanges!) is { } id ? Error("NOT_SUPPORTED", catalog.Logins.Message(id)) : null;
    }

    /// <summary>Login Properties' preflight of each changed database, in the plan's order, before anything runs: the database is there,
    /// online, open to this login and writable; with <paramref name="refuse"/> (OK, not Script), the user an update or unmap names is
    /// still the one mapped to the login and is not dbo, a database to map has no user mapped to it, a user's new name is free, and
    /// every role to add exists (when the list is not cut short). Answers the databases whose new default schema is missing, which get
    /// a CREATE SCHEMA step, or the first refusal. Script reads only the databases that set a default schema.</summary>
    private async Task<(HashSet<string> MissingSchemas, ActionError? Error)> PropertiesMappingPreflightAsync(SqlConnection connection, LoginChangesDto changes, byte[]? sid, bool refuse,
        CancellationToken token)
    {
        var missing = new HashSet<string>(StringComparer.Ordinal);
        var take = (int)catalog.Logins.Limit("roles");
        var mappings = changes.Mappings ?? [];
        foreach (var database in LoginSql.Ordered(mappings.Select(mapping => mapping.Database)))
        {
            var mapping = mappings.First(item => item.Database == database);
            if (!refuse && mapping.DefaultSchema is null) continue;
            if (await DatabaseUnavailableAsync(connection, database, token) is { } unavailable) return (missing, unavailable);
            var shown = ScriptingErrors.Display(database);
            if (refuse && sid is not null)
            {
                await using var command = connection.CreateCommand();
                command.CommandText = ActionSql.MappedUserCall;
                command.CommandTimeout = 0;
                Add(command, "@db", SqlDbType.NVarChar, 128, database);
                Add(command, "@stmt", SqlDbType.NVarChar, -1, LoginSql.PropertiesMappedUser);
                Add(command, "@sid", SqlDbType.VarBinary, 85, sid);
                Add(command, "@take", SqlDbType.Int, 0, 2);
                await using var reader = await command.ExecuteReaderAsync(token);
                string? user = null;
                var owner = false;
                if (await reader.ReadAsync(token)) { user = reader.GetString(0); owner = reader.GetBoolean(2); }
                if (mapping.Change == "map" && user is not null)
                    return (missing, Error("NAME_IN_USE", "The login is already mapped to the user " + ScriptingErrors.Display(user) + " in the database " + shown + ". Refresh Login Properties."));
                if (mapping.Change != "map" && !string.Equals(user, mapping.User, StringComparison.Ordinal))
                    return (missing, Error("NOT_FOUND", "The login is no longer mapped to the user " + ScriptingErrors.Display(mapping.User) + " in the database " + shown + ". Refresh Login Properties."));
                if (mapping.Change != "map" && owner)
                    return (missing, Error("NOT_SUPPORTED", "The login owns the database " + shown + ", so its user dbo cannot be changed here."));
            }
            if (mapping.Change == "unmap") continue;
            var name = mapping.Change == "map" ? mapping.User : mapping.NewName ?? mapping.User;
            await using var check = ModuleCommand(connection, database, LoginSql.MappingPreflight, name, mapping.DefaultSchema, take + 1);
            await using var rows = await check.ExecuteReaderAsync(token);
            if (!await rows.ReadAsync(token)) continue;
            var row = ReadRow(rows);
            if (!row.Bool("schema_exists")) missing.Add(database);
            if (!refuse) continue;
            if ((mapping.Change == "map" || mapping.NewName is not null) && row.Bool("user_in_use"))
                return (missing, Error("NAME_IN_USE", "The database " + shown + " already has a user or role named " + ScriptingErrors.Display(name) + "."));
            var roles = new List<string>();
            if (await rows.NextResultAsync(token)) while (await rows.ReadAsync(token)) roles.Add(rows.GetString(0));
            if (roles.Count <= take && LoginSql.Ordered(mapping.RolesAdd ?? []).FirstOrDefault(role => !roles.Contains(role, StringComparer.OrdinalIgnoreCase)) is { } absent)
                return (missing, Error("NOT_FOUND", "The database " + shown + " has no role named " + ScriptingErrors.Display(absent) + "."));
        }
        return (missing, null);
    }

    /// <summary>Script Action: built from the request, as SSMS's Script runs nothing; passwords are the placeholders (one XACT_ABORT batch
    /// under the header, critic A14). It reads only whether the login still exists and whether each new default schema does. Every
    /// unmapped database adds a warning that the script drops its user.</summary>
    private async Task<ActionScriptResult> ScriptLoginPropertiesJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var (facts, _) = await LoginAsync(connection, target.Name!, null, null, token);
        if (facts is null) return new(null, "master", [], Error("NOT_FOUND", "The login " + Display(target) + " no longer exists. Refresh Object Explorer."));
        var changes = args.LoginChanges!;
        var (missing, error) = await PropertiesMappingPreflightAsync(connection, changes, null, refuse: false, token);
        if (error is not null) return new(null, "master", [], error);
        var text = LoginSql.PropertiesScriptText(target.Name!, changes, missing, catalog.Logins.ScriptHeader, PermissionStatements(target.Name!, changes.Permissions));
        if (text.Length > ScriptLimit(args.Action)) return new(null, "master", [], Error("SQL_ERROR", "The script is too large."));
        return new(text, "master", LoginPropertiesWarnings(target.Name!, changes));
    }

    /// <summary>The steps preview's and Script's warnings: each DROP USER, which removes the user's permissions in its database (D2 §4),
    /// then each permission statement with CASCADE, which also revokes the permission from every principal the login granted it to
    /// (securables.ts securablesMessages.cascades), in the order they run.</summary>
    internal List<string> LoginPropertiesWarnings(string login, LoginChangesDto changes) =>
        [.. LoginSql.Ordered((changes.Mappings ?? []).Where(mapping => mapping.Change == "unmap").Select(mapping => mapping.Database))
            .Select(database => "Drops the user " + ActionSql.Quote(changes.Mappings!.First(mapping => mapping.Database == database).User) + " in " + ActionSql.Quote(database) + "."),
         .. PermissionSql.Ordered(catalog.Logins.Securables, changes.Permissions ?? []).Where(permission => permission.State == "revokeGrantOption" || permission.Cascade == true)
            .Select(permission => "CASCADE also revokes " + permission.Permission + (permission.Securable.Name is { } name ? " on " + ActionSql.Quote(name) : "") + " from every principal "
                + ActionSql.Quote(login) + " granted it to.")];

    /// <summary>OK: the preflight (the login, the identity the dialog read and the rules; then each changed database's), then the
    /// statements one by one in SSMS's order. What SQL Server says is scrubbed of both passwords. SQL Server answers a wrong old
    /// password, and a missing permission, with 15151; the reply adds which to check.</summary>
    private async Task<ActionExecuteResult> ExecuteLoginPropertiesJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        var changes = args.LoginChanges!;
        var (facts, row) = await LoginAsync(connection, target.Name!, null, null, token);
        if (facts is null) return new([], [], 0, Error("NOT_FOUND", "The login " + Display(target) + " no longer exists. Refresh Object Explorer."));
        if (LoginPropertiesRefusal(facts, args) is { } refused) return new([], [], 0, refused);
        if (row!.Raw("create_date") is not DateTime created) return new([], [], 0, Error("NOT_FOUND", "The login " + Display(target) + " changed while it was read. Refresh Object Explorer and try again."));
        var sid = SidBytes(facts);
        var (missing, mappingRefused) = await PropertiesMappingPreflightAsync(connection, changes, sid, refuse: true, token);
        if (mappingRefused is not null) return new([], [], 0, mappingRefused);
        var secrets = args.Secrets;
        string Scrubbed(string text) => LoginSql.Scrub(text, secrets);
        var login = target.Name!;
        // Every statement is bound to the login the preflight read: one renamed, dropped or replaced while an earlier step waited is
        // never changed in its place.
        var bound = new PrincipalBinding(sid, facts.PrincipalId, created);
        var self = new Bind(true, login, "master");
        var steps = new List<RunStep>();
        if (LoginSql.HasOptions(changes))
            steps.Add(new(LoginOptionsStep, context => RunBoundAsync(connection, bound, self, self, open => AlterLoginOptionsAsync(connection, login, changes, dryRun: false, context.Token, open), context.Token)));
        if (changes.Password is { } password)
            steps.Add(new(LoginPasswordStep, context => RunBoundAsync(connection, bound, self, self,
                open => AlterLoginPasswordAsync(connection, login, password, secrets?.Password, secrets?.OldPassword, dryRun: false, context.Token, open), context.Token)));
        steps.AddRange(LoginSql.PropertiesServerPlan(login, changes, bound).Concat(LoginSql.PropertiesMappingPlan(login, changes, missing, bound)).Select(ActionSql.Checked).Select(statement =>
            new RunStep(StepTitle(statement.Template), context => RunPlannedBoundAsync(connection, statement, context.Token), Detail: StepDetail(statement))));
        // The Securables page's statements last, each bound to the login like the server statements before them.
        steps.AddRange(PermissionSteps(changes.Permissions, (permission, context) =>
            RunBoundAsync(connection, bound, self, self, open => SetPermissionAsync(connection, login, facts.PrincipalId, permission, context.Token, open), context.Token)));
        var (done, failure, _) = await RunStepsAsync(connection, steps, null, token, CleanupBudget(args.Action), serverText: Scrubbed);
        // The connections that sign in as this login keep working: their later sessions use the new password, never the old one.
        if (secrets?.Password is { } changed && done.Any(step => step.Title == LoginPasswordStep && step.Status == "done"))
            host.PasswordChanged(args.ConnectionId, row.Text("name") ?? login, changed);
        if (failure is not null) failure = PartlyChanged(failure, done, changes.Password?.OldPassword == true);
        return new(done, [.. messages.Collected().Select(Scrubbed)], 0, failure);
    }

    /// <summary>Which principal a bound step checks (ActionSql.BindingOf): the login, or in <c>Database</c> the user with the login's SID,
    /// by name.</summary>
    internal readonly record struct Bind(bool Login, string Name, string Database);

    /// <summary>A planned statement of Login Properties' run: a bound one through <see cref="RunBoundAsync"/>, DROP USER (guarded in its own
    /// batch) as it is.</summary>
    private Task RunPlannedBoundAsync(SqlConnection connection, PlannedStatement statement, CancellationToken token)
    {
        if (statement.Principal is not { } bound || ActionSql.BindingOf(statement.Template) is not { } shape) return RunStatementAsync(connection, statement, dryRun: false, token);
        var names = statement.Names;
        return RunBoundAsync(connection, bound, new(shape.Login, names[shape.Name], statement.Database), new(shape.AfterLogin, names[shape.AfterName], statement.Database),
            open => RunStatementAsync(connection, statement, dryRun: false, token, open), token);
    }

    /// <summary>Runs one step bound to the principals the preflight read (review of D2c): in a transaction of its own, the
    /// <paramref name="before"/> check (ActionSql.LoginBinding or UserBindingCall, waiting behind any open change to the principal), the
    /// statement, then the <paramref name="after"/> check, so the step is undone when the name it acted on belonged to another principal
    /// by then. A failure or Stop rolls it back (within StopGrace, else closing the unpooled connection ends the session).</summary>
    private async Task RunBoundAsync(SqlConnection connection, PrincipalBinding bound, Bind before, Bind after, Func<SqlTransaction, Task> run, CancellationToken token)
    {
        var open = (SqlTransaction)await connection.BeginTransactionAsync(token);
        var committed = false;
        try
        {
            await CheckBindingAsync(connection, open, bound, before, token);
            await run(open);
            await CheckBindingAsync(connection, open, bound, after, token);
            await open.CommitAsync(CancellationToken.None);
            committed = true;
        }
        finally
        {
            // XACT_ABORT has rolled back a failed statement's transaction already (its Connection is then null).
            if (!committed && open.Connection is not null)
            {
                try { await open.RollbackAsync(CancellationToken.None).WaitAsync(Options.StopGrace, CancellationToken.None); }
                catch (Exception) { try { await connection.CloseAsync(); } catch (Exception) { } }
            }
            await open.DisposeAsync();
        }
    }

    private static async Task CheckBindingAsync(SqlConnection connection, SqlTransaction transaction, PrincipalBinding bound, Bind bind, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = 0;
        command.CommandText = bind.Login ? ActionSql.LoginBinding : ActionSql.UserBindingCall;
        if (!bind.Login) Add(command, "@db", SqlDbType.NVarChar, 128, bind.Database);
        Add(command, "@name", SqlDbType.NVarChar, 128, bind.Name);
        Add(command, "@sid", SqlDbType.VarBinary, 85, bound.Sid);
        if (bind.Login)
        {
            Add(command, "@principal", SqlDbType.Int, 0, bound.PrincipalId ?? throw new InvalidOperationException("A login's binding needs its principal_id."));
            Add(command, "@created", SqlDbType.DateTime, 0, bound.Created ?? throw new InvalidOperationException("A login's binding needs its create_date."));
        }
        // Through a reader, as every action statement (ReadAllAsync): its THROW is the answer.
        await ReadAllAsync(command, token);
    }

    /// <summary>A failure or Stop of Login Properties: 15151 (PERMISSION_DENIED) gets what to check, the old password when its step
    /// failed with one, else the permissions; and after a completed step the message starts by saying the login changed in part, so
    /// a clip cuts the list of completed steps, never that.</summary>
    internal static ActionError PartlyChanged(ActionError failure, IReadOnlyList<ActionStepDto> steps, bool oldPassword)
    {
        var message = failure.Message;
        if (failure.Code == "PERMISSION_DENIED")
            message += " " + (oldPassword && steps.Any(step => step.Title == LoginPasswordStep && step.Status == "failed") ? LoginOldPasswordAdvice : ActionErrors.LoginPermissionAdvice);
        if (steps.Any(step => step.Status == "done")) message = LoginChangedMessage + " " + message;
        return failure with { Message = ScriptingErrors.Clip(message, ActionErrors.MaxMessage) };
    }

    /// <summary>What a 15151 after an old password most likely means (D2 §4, probed): the old password is wrong.</summary>
    internal const string LoginOldPasswordAdvice = "Check the old password.";

    /// <summary>Runs (or dry-runs) the options' ALTER LOGIN (LoginSql.OptionsExecutable).</summary>
    private static async Task<List<string?>> AlterLoginOptionsAsync(SqlConnection connection, string login, LoginChangesDto changes, bool dryRun, CancellationToken token, SqlTransaction? transaction = null)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = LoginSql.OptionsExecutable(changes, dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, "master");
        Add(command, "@p1", SqlDbType.NVarChar, 128, login);
        if (changes.DefaultDatabase is { } database) Add(command, "@p2", SqlDbType.NVarChar, 128, database);
        if (changes.DefaultLanguage is { } language) Add(command, "@p3", SqlDbType.NVarChar, 128, language);
        return await ReadValuesAsync(command, token);
    }

    /// <summary>Runs (or dry-runs) the password's ALTER LOGIN (LoginSql.PasswordExecutable). Each password is one nvarchar(128)
    /// parameter, cleared once the batch ends.</summary>
    private static async Task<List<string?>> AlterLoginPasswordAsync(SqlConnection connection, string login, LoginPasswordChangeDto password, string? value, string? oldValue, bool dryRun,
        CancellationToken token, SqlTransaction? transaction = null)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = LoginSql.PasswordExecutable(password, dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, "master");
        Add(command, "@p1", SqlDbType.NVarChar, 128, login);
        var secret = command.Parameters.Add(new SqlParameter("@password", SqlDbType.NVarChar, 128) { Value = (object?)value ?? DBNull.Value });
        var old = password.OldPassword ? command.Parameters.Add(new SqlParameter("@old_password", SqlDbType.NVarChar, 128) { Value = (object?)oldValue ?? DBNull.Value }) : null;
        try { return await ReadValuesAsync(command, token); }
        finally
        {
            secret.Value = DBNull.Value;
            if (old is not null) old.Value = DBNull.Value;
        }
    }

    private static async Task<List<string?>> ReadValuesAsync(SqlCommand command, CancellationToken token)
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

    /// <summary>The live checks' only way to see the ALTER LOGIN statements SQL Server would build for Login Properties' options and a
    /// password change (see DryRunCreateLoginAsync). Not reachable from the wire.</summary>
    internal async Task<(string? Options, string? Password)> DryRunLoginPropertiesAsync(string connectionId, string login, LoginChangesDto changes, string? password, string? oldPassword,
        CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        var options = LoginSql.HasOptions(changes) ? (await AlterLoginOptionsAsync(connection, login, changes, dryRun: true, token)).SingleOrDefault() : null;
        var statement = changes.Password is { } change ? (await AlterLoginPasswordAsync(connection, login, change, password, oldPassword, dryRun: true, token)).SingleOrDefault() : null;
        return (options, statement);
    }
}
