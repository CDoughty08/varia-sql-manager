using System.Text;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>
/// New Login's SQL (D2a, D2b): its describe and preflight in master, User Mapping's read and preflight of each mapped database,
/// the CREATE LOGIN builder, the statements after it, and Script Action's text. CREATE LOGIN takes its password only as a literal, so SQL Server builds the statement from constant text:
/// names reach it as nvarchar(128) parameters through QUOTENAME, and the password as one nvarchar(128) parameter, read once,
/// quoted by a binary-collation REPLACE (a width-insensitive collation would double U+FF07 too, and store another password).
/// The client never formats a value into SQL text, and no batch returns, logs or passes on the password.
/// </summary>
internal static partial class LoginSql
{
    public static string NL => ScriptFormatter.NewLine;
    /// <summary>The batch refuses to run without its password rather than create a login with a NULL one.</summary>
    internal const string PasswordGuard = "IF @password IS NULL THROW 50000, N'The password is missing.', 1;\n";
    /// <summary>The only form the password may take in a batch: PASSWORD=N'…' with its quotes doubled on the server.</summary>
    internal const string PasswordExpression = "N' WITH PASSWORD=N''' + REPLACE(@password COLLATE Latin1_General_BIN2, N'''', N'''''') + N''''";
    /// <summary>Script Action's stand-in: unquoted, so a script run unedited fails to parse (102) and creates nothing.</summary>
    public const string Placeholder = "<password>";

    /// <summary>The keyword text a CREATE LOGIN or ALTER LOGIN batch is built from: every literal it holds besides the guard
    /// messages and the passwords' own delimiters. Each matches <see cref="KeywordLiteral"/>: no quote, bracket, comment or line
    /// break. Login Properties' options (D2c) each come as " WITH " or ", " before one of SMO's clauses.</summary>
    internal static readonly IReadOnlySet<string> Fragments = new HashSet<string>(new[]
    {
        "N'CREATE LOGIN '", "N' FROM WINDOWS WITH DEFAULT_DATABASE='", "N' MUST_CHANGE'", "N', DEFAULT_DATABASE='", "N', DEFAULT_LANGUAGE='",
        "N', CHECK_EXPIRATION=ON, CHECK_POLICY=ON'", "N', CHECK_EXPIRATION=OFF, CHECK_POLICY=ON'", "N', CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF'",
        "N'ALTER LOGIN '", "N' UNLOCK'"
    }.Concat(OptionKeywords.SelectMany(keyword => new[] { "N' WITH " + keyword + "'", "N', " + keyword + "'" })), StringComparer.Ordinal);
    /// <summary>The guard messages and the module suffix, the batch's only other literals.</summary>
    internal static readonly IReadOnlySet<string> Messages = new HashSet<string>(StringComparer.Ordinal)
    {
        "N'The password is missing.'", "N'The old password is missing.'", "N'A name could not be quoted.'", "N'.sys.sp_executesql'"
    };

    // --- Catalog statements -----------------------------------------------------------------------------------------------

    /// <summary>New Login's describe, in master: whether the server takes Windows authentication only and whether this login may
    /// create logins (advisory: NULL does not warn), then at most @databases databases with their state, this login's access and
    /// whether they are read-only (ActionSql.ReadOnlyFact),
    /// @languages languages and @roles server roles (each one more than listed, so a truncation shows).</summary>
    public const string Describe = "SELECT CONVERT(bit, CASE WHEN CONVERT(int, SERVERPROPERTY('IsIntegratedSecurityOnly')) = 1 THEN 1 ELSE 0 END) AS windows_only, "
        + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY LOGIN'), 1)) AS can_create;\n"
        + "SELECT TOP (@databases) d.name AS name, d.state AS state, CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) AS has_access, "
        + ActionSql.ReadOnlyFact + " AS read_only FROM sys.databases AS d ORDER BY d.name;\n"
        + "SELECT TOP (@languages) l.name AS name, l.alias AS alias FROM sys.syslanguages AS l ORDER BY l.name;\n"
        + "SELECT TOP (@roles) p.name AS name, p.is_fixed_role AS is_fixed FROM sys.server_principals AS p WHERE p.type = 'R' ORDER BY p.name;";

    /// <summary>The preflight on the action's own connection, before anything runs: whether a server principal (a login or a server
    /// role) has the name, and whether this login may create logins (NULL does not refuse).</summary>
    public const string Preflight = "SELECT CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = @name) THEN 1 ELSE 0 END) AS name_in_use, "
        + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY LOGIN'), 1)) AS can_create;";

    // --- CREATE LOGIN -----------------------------------------------------------------------------------------------------

    /// <summary>SQL Server's password options as SMO writes them; the request's chain (MUST_CHANGE needs CHECK_EXPIRATION, which
    /// needs CHECK_POLICY) leaves three.</summary>
    private static string Policy(NewLoginDto login) => (login.CheckPolicy, login.CheckExpiration) switch
    {
        (true, true) => ", CHECK_EXPIRATION=ON, CHECK_POLICY=ON",
        (true, _) => ", CHECK_EXPIRATION=OFF, CHECK_POLICY=ON",
        _ => ", CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF"
    };

    private static bool Sql(NewLoginDto login) => login.Auth == "sql";

    /// <summary>The batch that creates the login: @db (master), @p1 the login, @p2 the default database, @p3 the default language
    /// when one is chosen, and for a SQL Server login @password. <paramref name="dryRun"/> (the live checks only, never the wire)
    /// selects the statement instead of running it.</summary>
    public static string CreateExecutable(NewLoginDto login, bool dryRun = false)
    {
        var build = new StringBuilder();
        if (Sql(login)) build.Append(PasswordGuard);
        build.Append("DECLARE @stmt nvarchar(max) = N'CREATE LOGIN ' + QUOTENAME(@p1) + ");
        if (Sql(login))
        {
            build.Append(PasswordExpression);
            if (login.MustChange == true) build.Append(" + N' MUST_CHANGE'");
            build.Append(" + N', DEFAULT_DATABASE=' + QUOTENAME(@p2)");
        }
        else build.Append("N' FROM WINDOWS WITH DEFAULT_DATABASE=' + QUOTENAME(@p2)");
        if (login.DefaultLanguage is not null) build.Append(" + N', DEFAULT_LANGUAGE=' + QUOTENAME(@p3)");
        if (Sql(login)) build.Append(" + N'").Append(Policy(login)).Append('\'');
        build.Append(";\n").Append(ActionSql.Guard);
        build.Append(dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
        return build.ToString();
    }

    /// <summary>The statement as SMO writes it, names quoted by C#'s QUOTENAME: with <paramref name="password"/> as an N'…' literal
    /// (the live checks' dry runs compare it with what SQL Server builds), or <see cref="Placeholder"/> when it is null (Script).</summary>
    public static string CreateStatement(NewLoginDto login, string? password)
    {
        var text = new StringBuilder("CREATE LOGIN ").Append(ActionSql.Quote(login.Name));
        if (Sql(login))
        {
            text.Append(" WITH PASSWORD=").Append(password is null ? Placeholder : "N'" + password.Replace("'", "''", StringComparison.Ordinal) + "'");
            if (login.MustChange == true) text.Append(" MUST_CHANGE");
            text.Append(", DEFAULT_DATABASE=").Append(ActionSql.Quote(login.DefaultDatabase));
        }
        else text.Append(" FROM WINDOWS WITH DEFAULT_DATABASE=").Append(ActionSql.Quote(login.DefaultDatabase));
        if (login.DefaultLanguage is { } language) text.Append(", DEFAULT_LANGUAGE=").Append(ActionSql.Quote(language));
        if (Sql(login)) text.Append(Policy(login));
        return text.ToString();
    }

    /// <summary>Server roles in the order the statements run: by name, case-insensitively, then ordinally.</summary>
    public static List<string> Ordered(IEnumerable<string> roles) => [.. roles.Order(StringComparer.OrdinalIgnoreCase).ThenBy(role => role, StringComparer.Ordinal)];

    /// <summary>The statements after CREATE LOGIN, in SSMS's order (D2 §0): DENY CONNECT SQL, then ALTER LOGIN … DISABLE, then
    /// ALTER SERVER ROLE … ADD MEMBER per role.</summary>
    public static List<PlannedStatement> After(NewLoginDto login, IReadOnlyList<string> roles, LoginStatusDto status)
    {
        var plan = new List<PlannedStatement>();
        if (status.Connect == "deny") plan.Add(new(ActionTemplate.DenyConnect, "master", [login.Name]));
        if (!status.Enabled) plan.Add(new(ActionTemplate.DisableLogin, "master", [login.Name]));
        foreach (var role in Ordered(roles)) plan.Add(new(ActionTemplate.AddServerRoleMember, "master", [role, login.Name]));
        return plan;
    }

    /// <summary>User Mapping's statements (D2 §3.3), after the server roles: per database in name order (Ordered), CREATE USER … FOR
    /// LOGIN, then ALTER USER … WITH DEFAULT_SCHEMA when a schema is chosen and CREATE SCHEMA … AUTHORIZATION the user when the
    /// database has no such schema (<paramref name="missingSchemas"/>, by database, from the preflight or Script's read), then ALTER
    /// ROLE … ADD MEMBER per role in name order: the ported ApplyDatabaseRoleChanges' order. Each runs in its database.</summary>
    public static List<PlannedStatement> Mappings(NewLoginDto login, IReadOnlyList<UserMappingDto> mappings, IReadOnlySet<string> missingSchemas)
    {
        var plan = new List<PlannedStatement>();
        var byName = mappings.ToDictionary(mapping => mapping.Database, StringComparer.Ordinal);
        foreach (var database in Ordered(byName.Keys))
        {
            var mapping = byName[database];
            plan.Add(new(ActionTemplate.CreateUserForLogin, database, [mapping.User, login.Name]));
            if (mapping.DefaultSchema is { } schema)
            {
                plan.Add(new(ActionTemplate.AlterUserSchema, database, [mapping.User, schema]));
                if (missingSchemas.Contains(database)) plan.Add(new(ActionTemplate.CreateSchemaFor, database, [schema, mapping.User]));
            }
            foreach (var role in Ordered(mapping.RolesAdd)) plan.Add(new(ActionTemplate.AddRoleMember, database, [role, mapping.User]));
        }
        return plan;
    }

    /// <summary>The most statements New Login plans (src/shared/actions/logins.ts newLoginStatements): CREATE LOGIN, Deny, Disable,
    /// each server role, per mapping CREATE USER, the default schema's two and one per role, and one per permission (D2d).</summary>
    public static int Statements(LoginStatusDto status, IReadOnlyCollection<string> roles, IReadOnlyList<UserMappingDto> mappings, int permissions = 0) =>
        1 + (status.Connect == "deny" ? 1 : 0) + (status.Enabled ? 0 : 1) + roles.Count + mappings.Sum(mapping => 1 + (mapping.DefaultSchema is null ? 0 : 2) + mapping.RolesAdd.Count) + permissions;

    /// <summary>Script Action's text (D2 §5.6, critic A14). A SQL Server login's script is one batch in one XACT_ABORT transaction
    /// under the placeholder header: unedited, it fails to parse and runs nothing, so no later statement can give a role to an
    /// existing login of that name or map a user to it; a mapped database's statement runs there as EXEC [db].sys.sp_executesql
    /// N'…' (one batch cannot USE a database for a later statement only). A Windows login's script is SSMS's: a GO after each
    /// statement, and USE [db] before each mapped database's. The Securables page's statements (<paramref name="permissions"/>, D2d)
    /// come last, in master: after USE [master] again when a mapped database's statements came before them.</summary>
    public static string ScriptText(NewLoginDto login, IReadOnlyList<string> roles, LoginStatusDto status, IReadOnlyList<UserMappingDto> mappings, IReadOnlySet<string> missingSchemas, string header,
        IReadOnlyList<string>? permissions = null)
    {
        var server = new List<string> { CreateStatement(login, null) };
        server.AddRange(After(login, roles, status).Select(ActionSql.Checked).Select(ActionSql.Statement));
        var mapped = Mappings(login, mappings, missingSchemas).Select(ActionSql.Checked).ToList();
        return Script(server, mapped, permissions ?? [], Sql(login), header);
    }

    /// <summary>The two script forms of New Login and Login Properties: SSMS's (a GO after each statement, USE [db] before each mapped
    /// database's, USE [master] again before the permissions after them), or with a password one XACT_ABORT batch under the header,
    /// each mapped database's statement through its sp_executesql.</summary>
    internal static string Script(IReadOnlyList<string> server, IReadOnlyList<PlannedStatement> mapped, IReadOnlyList<string> permissions, bool oneBatch, string header)
    {
        var text = new StringBuilder("USE [master]").Append(NL).Append("GO").Append(NL);
        if (!oneBatch)
        {
            foreach (var statement in server) text.Append(statement).Append(NL).Append("GO").Append(NL);
            foreach (var statement in mapped) text.Append(ActionSql.ScriptText(statement));
            if (mapped.Count > 0 && permissions.Count > 0) text.Append("USE [master]").Append(NL).Append("GO").Append(NL);
            foreach (var statement in permissions) text.Append(statement).Append(NL).Append("GO").Append(NL);
            return text.ToString();
        }
        text.Append(header).Append(NL).Append("SET XACT_ABORT ON;").Append(NL).Append("BEGIN TRANSACTION;").Append(NL);
        foreach (var statement in server) text.Append(statement).Append(';').Append(NL);
        foreach (var statement in mapped) text.Append(InDatabase(statement)).Append(';').Append(NL);
        foreach (var statement in permissions) text.Append(statement).Append(';').Append(NL);
        return text.Append("COMMIT TRANSACTION;").Append(NL).Append("GO").Append(NL).ToString();
    }

    /// <summary>A mapped database's statement inside the one-batch script: run in its database through that database's
    /// sp_executesql, with the statement's quotes doubled.</summary>
    public static string InDatabase(PlannedStatement statement) =>
        "EXEC " + ActionSql.Quote(statement.Database) + ".sys.sp_executesql N'" + ActionSql.Statement(statement).Replace("'", "''", StringComparison.Ordinal) + "'";

    // --- User Mapping's reads ---------------------------------------------------------------------------------------------

    /// <summary>User Mapping's read of one database (the loginDatabaseRoles describe), inside it through ActionSql.ModuleCall: at most
    /// @take database roles and @take schemas by name (the caller keeps loginLimits' counts and reads one more of each, so a
    /// truncation shows), and whether guest (principal_id 2 in every database) has CONNECT granted on the database, which SSMS's
    /// read-only Guest account enabled box shows.</summary>
    public const string DatabaseRoles = "SELECT TOP (@take) p.name AS name FROM sys.database_principals AS p WHERE p.type = 'R' ORDER BY p.name;\n"
        + "SELECT CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.database_permissions AS dp WHERE dp.grantee_principal_id = 2 AND dp.class = 0 AND dp.type = 'CO' AND dp.state IN ('G', 'W')) "
        + "THEN 1 ELSE 0 END) AS guest;\n"
        + "SELECT TOP (@take) s.name AS name FROM sys.schemas AS s ORDER BY s.name;";

    /// <summary>The preflight of one mapped database, inside it through ActionSql.ModuleCall, before anything runs: whether a database
    /// principal (a user or role) already has the user's name (@name), whether the default schema (@schema; NULL for none) exists,
    /// which decides the CREATE SCHEMA step, then at most @take database roles, so a role that is not there is refused early.</summary>
    public const string MappingPreflight = "SELECT CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.database_principals AS p WHERE p.name = @name) THEN 1 ELSE 0 END) AS user_in_use, "
        + "CONVERT(bit, CASE WHEN @schema IS NULL OR EXISTS (SELECT 1 FROM sys.schemas AS s WHERE s.name = @schema) THEN 1 ELSE 0 END) AS schema_exists;\n"
        + "SELECT TOP (@take) p.name AS name FROM sys.database_principals AS p WHERE p.type = 'R' ORDER BY p.name;";

    // --- Secrets ----------------------------------------------------------------------------------------------------------

    /// <summary>From this length a secret is also replaced where it stands unquoted. A shorter one is too likely to be part of the
    /// message's own words ("e", "in", "server"): replacing it would garble the message and show where the password's text occurs.</summary>
    public const int BareSecretLength = 8;

    /// <summary>Text SQL Server sent (an error or an informational message; never Varia's own sentences, step titles or names) with
    /// each secret replaced by <see cref="Placeholder"/>, ordinal: where it is quoted as a literal or name would be ('…', N'…' and
    /// "…", as typed or with its quotes doubled), and, from <see cref="BareSecretLength"/> characters, anywhere. SQL Server's
    /// messages hold no password in any probed case; this covers the unknown ones (a syntax error if the quoting were ever wrong).</summary>
    public static string Scrub(string text, LoginSecretsDto? secrets)
    {
        if (secrets is null) return text;
        foreach (var secret in new[] { secrets.Password, secrets.OldPassword })
        {
            if (string.IsNullOrEmpty(secret)) continue;
            // The doubled form first: the secret as typed is inside it.
            foreach (var form in new[] { secret.Replace("'", "''", StringComparison.Ordinal), secret }.Distinct(StringComparer.Ordinal))
            {
                text = text.Replace("'" + form + "'", "'" + Placeholder + "'", StringComparison.Ordinal).Replace("\"" + form + "\"", "\"" + Placeholder + "\"", StringComparison.Ordinal);
                if (secret.Length >= BareSecretLength) text = text.Replace(form, Placeholder, StringComparison.Ordinal);
            }
        }
        return text;
    }

    // --- Lint -------------------------------------------------------------------------------------------------------------

    [GeneratedRegex(@"^N'[A-Za-z0-9_ ():=;,#]*'$")]
    internal static partial Regex KeywordLiteral();
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();
    /// <summary>Names through QUOTENAME (@p1 to @p3), and the database only as the module it runs.</summary>
    [GeneratedRegex(@"QUOTENAME\(@p[1-3]\)|QUOTENAME\(@db\) \+ N'\.sys\.sp_executesql'")]
    private static partial Regex NameUse();
    [GeneratedRegex(@"\bEXEC(?:UTE)?\b", RegexOptions.IgnoreCase)]
    private static partial Regex Exec();
    [GeneratedRegex(@"\b(?:SID|HASHED|ROLLBACK|DROP|STRING_AGG|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b|xp_|EXEC\s*\(", RegexOptions.IgnoreCase)]
    private static partial Regex Banned();

    private static int Count(string text, string part)
    {
        var count = 0;
        for (var index = text.IndexOf(part, StringComparison.Ordinal); index >= 0; index = text.IndexOf(part, index + part.Length, StringComparison.Ordinal)) count++;
        return count;
    }

    /// <summary>Problems with one CREATE LOGIN or ALTER LOGIN batch (D2 §5.5's LoginBuilderRules; empty when it passes): a format
    /// hole, a secret use any lint refuses (critic A15), no quoting guard; @password other than exactly twice (its NULL guard first,
    /// then once through the binary-collation REPLACE), so no inner batch receives it and nothing returns it; @old_password (Login
    /// Properties, D2c) other than exactly twice (its NULL guard right after the password's, then once through the same REPLACE
    /// right after the password's), or without @password; a name outside QUOTENAME or @db outside the module; a literal that is
    /// neither keyword text from <see cref="Fragments"/> nor a guard message; not exactly one EXEC @module @stmt (or the dry run's
    /// SELECT); and a banned word (SID, HASHED, ROLLBACK, DROP, xp_, EXEC ( …).</summary>
    public static List<string> LintExecutable(string text)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        problems.AddRange(CatalogSql.SecretUses(text));
        if (!text.Contains(ActionSql.Guard, StringComparison.Ordinal)) problems.Add("has no quoting guard");
        var uses = Count(text, "@password");
        if (uses > 0)
        {
            if (!text.StartsWith(PasswordGuard, StringComparison.Ordinal)) problems.Add("does not check @password for NULL first");
            if (Count(text, PasswordExpression) != 1) problems.Add("does not quote @password exactly once through the binary-collation REPLACE");
            if (uses != 2) problems.Add("uses @password " + uses + " times");
        }
        var old = Count(text, "@old_password");
        if (old > 0)
        {
            if (!text.StartsWith(PasswordGuard + OldPasswordGuard, StringComparison.Ordinal)) problems.Add("does not check @old_password for NULL right after @password");
            if (Count(text, PasswordExpression + " + " + OldPasswordExpression) != 1 || Count(text, OldPasswordExpression) != 1)
                problems.Add("does not quote @old_password exactly once, right after the password, through the binary-collation REPLACE");
            if (old != 2) problems.Add("uses @old_password " + old + " times");
        }
        // What the passwords' own forms leave; a @password or @old_password still in it is reported once, here.
        var rest = text.Replace(PasswordGuard, "", StringComparison.Ordinal).Replace(OldPasswordGuard, "", StringComparison.Ordinal)
            .Replace(PasswordExpression, "", StringComparison.Ordinal).Replace(OldPasswordExpression, "", StringComparison.Ordinal);
        if (rest.Contains("@password", StringComparison.Ordinal)) problems.Add("uses @password outside its guard and REPLACE");
        if (rest.Contains("@old_password", StringComparison.Ordinal)) problems.Add("uses @old_password outside its guard and REPLACE");
        foreach (Match used in Variable().Matches(NameUse().Replace(rest, "")))
            if (used.Value is not ("@stmt" or "@module" or "@password" or "@old_password")) problems.Add("uses " + used.Value + " outside QUOTENAME");
        var runs = Count(text, "EXEC @module @stmt;") + Count(text, "SELECT @stmt AS stmt;");
        if (runs != 1 || Exec().Matches(text).Count != Count(text, "EXEC @module @stmt;")) problems.Add("does not run exactly one EXEC @module @stmt");
        if (Banned().IsMatch(text)) problems.Add("has a banned word: " + Banned().Match(text).Value);
        foreach (Match literal in LiteralPattern().Matches(rest))
            if (!Messages.Contains(literal.Value) && !(Fragments.Contains(literal.Value) && KeywordLiteral().IsMatch(literal.Value))) problems.Add("has the literal " + literal.Value);
        return problems;
    }

    /// <summary>Every CREATE LOGIN the builder can write (each auth, password option chain and language, run and dry run), and every
    /// ALTER LOGIN of Login Properties' options and password, with its lint problems (ActionSql.Lint).</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint()
    {
        foreach (var login in Corpus())
            foreach (var dry in new[] { false, true })
                yield return ("create login " + Shape(login) + (dry ? " (dry run)" : ""), LintExecutable(CreateExecutable(login, dry)));
        foreach (var item in PropertiesLint()) yield return item;
    }

    /// <summary>One login per shape the builder distinguishes.</summary>
    internal static IEnumerable<NewLoginDto> Corpus()
    {
        foreach (var language in new[] { null, "us_english" })
        {
            yield return new("windows", "DOMAIN\\name", "master", language);
            foreach (var (policy, expiration, mustChange) in new[] { (true, true, true), (true, true, false), (true, false, false), (false, false, false) })
                yield return new("sql", "name", "master", language, policy, expiration, mustChange);
        }
    }

    private static string Shape(NewLoginDto login) => login.Auth + (login.Auth == "sql" ? " policy " + login.CheckPolicy + " expiration " + login.CheckExpiration + " must change " + login.MustChange : "")
        + (login.DefaultLanguage is null ? "" : " with a language");
}
