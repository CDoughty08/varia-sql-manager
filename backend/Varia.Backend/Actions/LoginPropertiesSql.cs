using System.Text;

namespace Varia.Backend.Actions;

/// <summary>
/// Login Properties' SQL (D2c): its describe's reads (the login's defaults and server roles in master, and in each database the user
/// mapped to it), the two ALTER LOGIN builders (the options, and the password with its old password, UNLOCK and MUST_CHANGE), the
/// statements after them in SSMS's order, and Script Action's text. As in New Login, ALTER LOGIN takes a password only as a literal,
/// so SQL Server builds the statement from constant fragments: names through QUOTENAME, each password as one nvarchar(128)
/// parameter read once and quoted by a binary-collation REPLACE.
/// </summary>
internal static partial class LoginSql
{
    /// <summary>The batch refuses to run without the old password it was asked to send.</summary>
    internal const string OldPasswordGuard = "IF @old_password IS NULL THROW 50000, N'The old password is missing.', 1;\n";
    /// <summary>The only form the old password may take: OLD_PASSWORD=N'…', right after the new one, its quotes doubled on the server.</summary>
    internal const string OldPasswordExpression = "N' OLD_PASSWORD=N''' + REPLACE(@old_password COLLATE Latin1_General_BIN2, N'''', N'''''') + N''''";
    /// <summary>Script Action's stand-in for the old password: unquoted, as <see cref="Placeholder"/> is.</summary>
    public const string OldPlaceholder = "<old password>";

    // --- Reads ------------------------------------------------------------------------------------------------------------

    /// <summary>Login Properties' read of the login in master, by the principal_id the login preflight found: its default database
    /// and language, then at most @roles server roles it is a member of, by name (the caller reads one more, so a truncation shows).</summary>
    public const string PropertiesRead = "SELECT p.default_database_name AS default_database, p.default_language_name AS default_language FROM sys.server_principals AS p WHERE p.principal_id = @principal;\n"
        + "SELECT TOP (@roles) r.name AS name FROM sys.server_role_members AS m JOIN sys.server_principals AS r ON r.principal_id = m.role_principal_id "
        + "WHERE m.member_principal_id = @principal ORDER BY r.name;";

    /// <summary>A login's SID by its name, for User Mapping's read of its user in one database (the loginDatabaseRoles describe with a login).</summary>
    public const string LoginSid = "SELECT p.sid AS sid FROM sys.server_principals AS p WHERE p.name = @name AND p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X');";

    /// <summary>Inside one database (through ActionSql.MappedUserCall, as D4c's scan runs ActionSql.MappedUser): at most @take users mapped to
    /// the login's SID, by name, with their default schema and whether the user is dbo (the login owns the database: SSMS lists it,
    /// and it can be neither unmapped nor renamed).</summary>
    public const string PropertiesMappedUser = "SELECT TOP (@take) u.name AS user_name, u.default_schema_name AS default_schema, "
        + "CONVERT(bit, CASE WHEN u.principal_id = 1 THEN 1 ELSE 0 END) AS is_owner FROM sys.database_principals AS u "
        + "WHERE u.sid = @sid AND u.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY u.name;";

    /// <summary>Inside one database (through ActionSql.MappedUserCall): the user mapped to the login's SID (the first by principal_id)
    /// with its default schema and whether it is dbo, then at most @take database roles it is a member of, by name. Login
    /// Properties' User Mapping reads it when a database is selected, as SSMS's InitializeRoleMembership does.</summary>
    public const string DatabaseUser = "SELECT TOP (1) u.name AS user_name, u.default_schema_name AS default_schema, CONVERT(bit, CASE WHEN u.principal_id = 1 THEN 1 ELSE 0 END) AS is_owner "
        + "FROM sys.database_principals AS u WHERE u.sid = @sid AND u.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY u.principal_id;\n"
        + "SELECT TOP (@take) r.name AS name FROM sys.database_role_members AS m JOIN sys.database_principals AS r ON r.principal_id = m.role_principal_id "
        + "JOIN sys.database_principals AS u ON u.principal_id = m.member_principal_id WHERE u.sid = @sid AND u.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY r.name;";

    // --- ALTER LOGIN: the options -------------------------------------------------------------------------------------------

    /// <summary>The clauses of the options statement, each the text after " WITH " or ", " (Fragments): a property, not a field, so
    /// LoginSql's static fields in the other file can read it whatever order they are initialised in.</summary>
    internal static string[] OptionKeywords => ["DEFAULT_DATABASE=", "DEFAULT_LANGUAGE=", "CHECK_EXPIRATION=ON", "CHECK_EXPIRATION=OFF", "CHECK_POLICY=ON", "CHECK_POLICY=OFF"];

    /// <summary>Whether the changes hold an option of the login's own ALTER LOGIN (General's defaults and password policy).</summary>
    public static bool HasOptions(LoginChangesDto changes) => changes.DefaultDatabase is not null || changes.DefaultLanguage is not null || changes.CheckPolicy is not null || changes.CheckExpiration is not null;

    /// <summary>The changed clauses in SMO's order (captured by D2: DEFAULT_DATABASE, DEFAULT_LANGUAGE, CHECK_EXPIRATION, CHECK_POLICY),
    /// each with the parameter it quotes, if any.</summary>
    private static IEnumerable<(string Keyword, string? Parameter)> OptionClauses(LoginChangesDto changes)
    {
        if (changes.DefaultDatabase is not null) yield return ("DEFAULT_DATABASE=", "@p2");
        if (changes.DefaultLanguage is not null) yield return ("DEFAULT_LANGUAGE=", "@p3");
        if (changes.CheckExpiration is { } expiration) yield return (expiration ? "CHECK_EXPIRATION=ON" : "CHECK_EXPIRATION=OFF", null);
        if (changes.CheckPolicy is { } policy) yield return (policy ? "CHECK_POLICY=ON" : "CHECK_POLICY=OFF", null);
    }

    /// <summary>The batch that changes the login's options in one ALTER LOGIN with only the changed clauses (D2 §4), before the
    /// password: @db (master), @p1 the login, @p2 the default database, @p3 the default language.</summary>
    public static string OptionsExecutable(LoginChangesDto changes, bool dryRun = false)
    {
        var build = new StringBuilder("DECLARE @stmt nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@p1)");
        var first = true;
        foreach (var (keyword, parameter) in OptionClauses(changes))
        {
            build.Append(" + N'").Append(first ? " WITH " : ", ").Append(keyword).Append('\'');
            if (parameter is not null) build.Append(" + QUOTENAME(").Append(parameter).Append(')');
            first = false;
        }
        if (first) throw new InvalidOperationException("The changes hold no option of the login.");
        build.Append(";\n").Append(ActionSql.Guard);
        build.Append(dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
        return build.ToString();
    }

    /// <summary>The options statement as SMO writes it, names quoted by C#'s QUOTENAME.</summary>
    public static string OptionsStatement(string login, LoginChangesDto changes)
    {
        var text = new StringBuilder("ALTER LOGIN ").Append(ActionSql.Quote(login));
        var first = true;
        foreach (var (keyword, parameter) in OptionClauses(changes))
        {
            text.Append(first ? " WITH " : ", ").Append(keyword);
            if (parameter == "@p2") text.Append(ActionSql.Quote(changes.DefaultDatabase!));
            else if (parameter == "@p3") text.Append(ActionSql.Quote(changes.DefaultLanguage!));
            first = false;
        }
        return text.ToString();
    }

    // --- ALTER LOGIN: the password ------------------------------------------------------------------------------------------

    /// <summary>The batch that changes the password (D2 §4): PASSWORD, then OLD_PASSWORD when the user gave it, else UNLOCK and
    /// MUST_CHANGE when asked (T-SQL's grammar takes the old password or those options, never both). @db (master), @p1 the login,
    /// @password and, with the old one, @old_password, each read once.</summary>
    public static string PasswordExecutable(LoginPasswordChangeDto password, bool dryRun = false)
    {
        var build = new StringBuilder(PasswordGuard);
        if (password.OldPassword) build.Append(OldPasswordGuard);
        build.Append("DECLARE @stmt nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@p1) + ").Append(PasswordExpression);
        if (password.OldPassword) build.Append(" + ").Append(OldPasswordExpression);
        else
        {
            if (password.Unlock) build.Append(" + N' UNLOCK'");
            if (password.MustChange) build.Append(" + N' MUST_CHANGE'");
        }
        build.Append(";\n").Append(ActionSql.Guard);
        build.Append(dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
        return build.ToString();
    }

    /// <summary>The password statement as SMO writes it (probed by D4: WITH PASSWORD=N'…' UNLOCK, and PASSWORD=N'…' OLD_PASSWORD=N'…'):
    /// with the passwords as N'…' literals (the live checks' dry runs), or the placeholders where they are null (Script).</summary>
    public static string PasswordStatement(string login, LoginPasswordChangeDto password, string? value, string? oldValue)
    {
        static string Literal(string text) => "N'" + text.Replace("'", "''", StringComparison.Ordinal) + "'";
        var text = new StringBuilder("ALTER LOGIN ").Append(ActionSql.Quote(login)).Append(" WITH PASSWORD=").Append(value is null ? Placeholder : Literal(value));
        if (password.OldPassword) text.Append(" OLD_PASSWORD=").Append(oldValue is null ? OldPlaceholder : Literal(oldValue));
        else
        {
            if (password.Unlock) text.Append(" UNLOCK");
            if (password.MustChange) text.Append(" MUST_CHANGE");
        }
        return text.ToString();
    }

    // --- The plan ---------------------------------------------------------------------------------------------------------

    /// <summary>The server statements after the options and the password, in SSMS's order (the ported SendChangeToServer): GRANT or
    /// DENY CONNECT SQL, ENABLE or DISABLE, then ALTER SERVER ROLE … ADD or DROP MEMBER per changed role, by name.</summary>
    public static List<PlannedStatement> PropertiesServerPlan(string login, LoginChangesDto changes)
    {
        var plan = new List<PlannedStatement>();
        if (changes.Connect is { } connect) plan.Add(new(connect == "deny" ? ActionTemplate.DenyConnect : ActionTemplate.GrantConnect, "master", [login]));
        if (changes.Enabled is { } enabled) plan.Add(new(enabled ? ActionTemplate.EnableLogin : ActionTemplate.DisableLogin, "master", [login]));
        var added = changes.RolesAdd ?? [];
        foreach (var role in Ordered(added.Concat(changes.RolesDrop ?? [])))
            plan.Add(new(added.Contains(role) ? ActionTemplate.AddServerRoleMember : ActionTemplate.DropServerRoleMember, "master", [role, login]));
        return plan;
    }

    /// <summary>User Mapping's statements (the ported ApplyDatabaseRoleChanges), per database in name order: an unmapped database's
    /// DROP USER (guarded by the login's <paramref name="sid"/> when it runs: the user must still be the one mapped to it); a newly
    /// mapped one's CREATE USER … FOR LOGIN; a mapped one's ALTER USER … WITH NAME when renamed. Then, for both, ALTER USER … WITH
    /// DEFAULT_SCHEMA (and CREATE SCHEMA when the database has no such schema, <paramref name="missingSchemas"/>) and ALTER ROLE …
    /// ADD or DROP MEMBER per changed role, by name. Each runs in its database.</summary>
    public static List<PlannedStatement> PropertiesMappingPlan(string login, LoginChangesDto changes, IReadOnlySet<string> missingSchemas, byte[]? sid = null)
    {
        var plan = new List<PlannedStatement>();
        var byName = (changes.Mappings ?? []).ToDictionary(mapping => mapping.Database, StringComparer.Ordinal);
        foreach (var database in Ordered(byName.Keys))
        {
            var mapping = byName[database];
            if (mapping.Change == "unmap")
            {
                plan.Add(new(ActionTemplate.DropMappedUser, database, [mapping.User], Principal: sid is null ? null : new(sid)));
                continue;
            }
            if (mapping.Change == "map") plan.Add(new(ActionTemplate.CreateUserForLogin, database, [mapping.User, login]));
            else if (mapping.NewName is { } renamed) plan.Add(new(ActionTemplate.RenameUser, database, [mapping.User, renamed]));
            var user = mapping.Change == "map" ? mapping.User : mapping.NewName ?? mapping.User;
            if (mapping.DefaultSchema is { } schema)
            {
                plan.Add(new(ActionTemplate.AlterUserSchema, database, [user, schema]));
                if (missingSchemas.Contains(database)) plan.Add(new(ActionTemplate.CreateSchemaFor, database, [schema, user]));
            }
            var added = mapping.RolesAdd ?? [];
            foreach (var role in Ordered(added.Concat(mapping.RolesDrop ?? [])))
                plan.Add(new(added.Contains(role) ? ActionTemplate.AddRoleMember : ActionTemplate.DropRoleMember, database, [role, user]));
        }
        return plan;
    }

    /// <summary>The most statements Login Properties plans (logins.ts loginPropertiesStatements): the options, the password, Connect,
    /// Enabled, each server role, and per database its DROP USER, or its CREATE USER or rename, the default schema's two and one per role.</summary>
    public static int PropertiesStatements(LoginChangesDto changes) =>
        (HasOptions(changes) ? 1 : 0) + (changes.Password is null ? 0 : 1) + (changes.Connect is null ? 0 : 1) + (changes.Enabled is null ? 0 : 1)
        + (changes.RolesAdd?.Count ?? 0) + (changes.RolesDrop?.Count ?? 0)
        + (changes.Mappings ?? []).Sum(mapping => mapping.Change == "unmap" ? 1
            : (mapping.Change == "map" || mapping.NewName is not null ? 1 : 0) + (mapping.DefaultSchema is null ? 0 : 2) + (mapping.RolesAdd?.Count ?? 0) + (mapping.RolesDrop?.Count ?? 0));

    /// <summary>Script Action's text of Login Properties (D2 §5.6, critic A14). With a password change: one batch in one XACT_ABORT
    /// transaction under the placeholder header, so a script run unedited fails to parse and changes nothing, each mapped database's
    /// statement as EXEC [db].sys.sp_executesql N'…'. Without one: SSMS's form, a GO after each statement and USE [db] before each
    /// mapped database's. Varia runs the statements one by one, as SSMS does.</summary>
    public static string PropertiesScriptText(string login, LoginChangesDto changes, IReadOnlySet<string> missingSchemas, string header)
    {
        var server = new List<string>();
        if (HasOptions(changes)) server.Add(OptionsStatement(login, changes));
        if (changes.Password is { } password) server.Add(PasswordStatement(login, password, null, null));
        server.AddRange(PropertiesServerPlan(login, changes).Select(ActionSql.Checked).Select(ActionSql.Statement));
        var mapped = PropertiesMappingPlan(login, changes, missingSchemas).Select(ActionSql.Checked).ToList();
        var text = new StringBuilder("USE [master]").Append(NL).Append("GO").Append(NL);
        if (changes.Password is null)
        {
            foreach (var statement in server) text.Append(statement).Append(NL).Append("GO").Append(NL);
            foreach (var statement in mapped) text.Append(ActionSql.ScriptText(statement));
            return text.ToString();
        }
        text.Append(header).Append(NL).Append("SET XACT_ABORT ON;").Append(NL).Append("BEGIN TRANSACTION;").Append(NL);
        foreach (var statement in server) text.Append(statement).Append(';').Append(NL);
        foreach (var statement in mapped) text.Append(InDatabase(statement)).Append(';').Append(NL);
        return text.Append("COMMIT TRANSACTION;").Append(NL).Append("GO").Append(NL).ToString();
    }

    // --- Lint corpus --------------------------------------------------------------------------------------------------------

    /// <summary>One change set per shape the options builder distinguishes: each subset of the four clauses, the flags on and off.</summary>
    internal static IEnumerable<LoginChangesDto> OptionsCorpus()
    {
        foreach (var database in new[] { null, "tempdb" })
            foreach (var language in new[] { null, "us_english" })
                foreach (var expiration in new bool?[] { null, true, false })
                    foreach (var policy in new bool?[] { null, true, false })
                    {
                        var changes = new LoginChangesDto(database, language, policy, expiration);
                        if (HasOptions(changes)) yield return changes;
                    }
    }

    /// <summary>Every password change the grammar allows: with the old password alone, or with UNLOCK and MUST_CHANGE in each combination.</summary>
    internal static IEnumerable<LoginPasswordChangeDto> PasswordCorpus()
    {
        yield return new(true, false, false);
        foreach (var unlock in new[] { false, true })
            foreach (var mustChange in new[] { false, true })
                yield return new(false, unlock, mustChange);
    }

    private static IEnumerable<(string Name, List<string> Problems)> PropertiesLint()
    {
        foreach (var changes in OptionsCorpus())
            foreach (var dry in new[] { false, true })
                yield return ("login options " + OptionsStatement("l", changes) + (dry ? " (dry run)" : ""), LintExecutable(OptionsExecutable(changes, dry)));
        foreach (var password in PasswordCorpus())
            foreach (var dry in new[] { false, true })
                yield return ("login password " + PasswordStatement("l", password, null, null) + (dry ? " (dry run)" : ""), LintExecutable(PasswordExecutable(password, dry)));
    }
}
