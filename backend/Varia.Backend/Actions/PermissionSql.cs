using System.Text;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>One securable type of the Securables page (src/shared/actions/securables.ts securableSpecs): its words, the class SQL
/// Server's permission functions take, sys.server_permissions' class, the ON clause before its quoted name (none for the server) and
/// the permissions it takes.</summary>
internal sealed record SecurableTypeJson(string Type, string Label, string Plural, string SqlClass, int ClassId, List<string> Permissions, string? On = null);
internal sealed record ReservedPermissionJson(string Type, string Permission);
/// <summary>The securables block of the logins catalogue (securables.ts securablesCatalog()).</summary>
internal sealed record SecurablesJson(string EffectiveDescribe, string EffectiveDenied, List<ReservedPermissionJson> Reserved, List<SecurableTypeJson> Types);

/// <summary>The Securables page's catalogue as C# reads it: C# holds no permission keyword of its own, and refuses a catalogue whose
/// keywords could carry anything but upper-case words.</summary>
internal sealed partial class SecurableCatalog
{
    private readonly Dictionary<string, SecurableTypeJson> types;
    private readonly HashSet<(string Type, string Permission)> reserved;

    public SecurableCatalog(SecurablesJson json)
    {
        Types = json.Types;
        types = json.Types.ToDictionary(type => type.Type, StringComparer.Ordinal);
        reserved = json.Reserved.Select(row => (row.Type, row.Permission)).ToHashSet();
        EffectiveDescribe = json.EffectiveDescribe;
        EffectiveDenied = json.EffectiveDenied;
        if (!types.TryGetValue("server", out var server) || server.On is not null || json.Types.Any(type => type.Type != "server" && (type.On is null || !OnClause().IsMatch(type.On))))
            throw new InvalidOperationException("The securable types' ON clauses are not the catalogue's form.");
        if (json.Types.Any(type => type.Permissions.Count == 0 || type.Permissions.Any(permission => !Keyword().IsMatch(permission)) || !Keyword().IsMatch(type.SqlClass)))
            throw new InvalidOperationException("A securable permission or class is not upper-case words.");
        if (json.Reserved.Any(row => !Takes(row.Type, row.Permission))) throw new InvalidOperationException("A reserved permission is not in the catalogue.");
    }

    [GeneratedRegex(@"^[A-Z]+(?: [A-Z]+)*$")]
    internal static partial Regex Keyword();
    [GeneratedRegex(@"^ ON [A-Z]+(?: [A-Z]+)*::$")]
    private static partial Regex OnClause();

    public IReadOnlyList<SecurableTypeJson> Types { get; }
    /// <summary>The describe id of the Effective tab's read (securables.ts loginEffectiveDescribe).</summary>
    public string EffectiveDescribe { get; }
    /// <summary>What the Effective tab says when SQL Server refuses EXECUTE AS LOGIN.</summary>
    public string EffectiveDenied { get; }

    public SecurableTypeJson? Type(string? type) => type is not null && types.TryGetValue(type, out var found) ? found : null;
    /// <summary>The type's place in the catalogue: the plan's order (the server first).</summary>
    public int Order(string type) => Types.ToList().FindIndex(row => row.Type == type);
    public bool Takes(string? type, string? permission) => Type(type) is { } spec && permission is not null && spec.Permissions.Contains(permission, StringComparer.Ordinal);
    /// <summary>A permission another page owns (CONNECT SQL: the Status page), which a Securables request never carries.</summary>
    public bool Reserved(string type, string permission) => reserved.Contains((type, permission));
}

/// <summary>
/// The Securables page's SQL (D2d): its reads (New Login's lists of securables and the permissions this server lists, Login Properties'
/// explicit permissions of the login, and the Effective tab's sys.fn_my_permissions under EXECUTE AS LOGIN) and the permission builder.
/// SQL Server builds each GRANT, DENY or REVOKE from constant keyword text: the verb, the permission and the ON clause come only from
/// the catalogue, and the login and the securable reach it as nvarchar(128) parameters through QUOTENAME. One statement per permission,
/// in master; ActionSql.LintExecutable's builder form and <see cref="LintExecutable"/> check every one the builder can write.
/// </summary>
internal static partial class PermissionSql
{
    public static string NL => ScriptFormatter.NewLine;
    /// <summary>The verbs' keyword text, before the permission.</summary>
    private static string Verb(string state) => state switch
    {
        "grant" or "withGrant" => "GRANT ",
        "deny" => "DENY ",
        "revoke" => "REVOKE ",
        "revokeGrantOption" => "REVOKE GRANT OPTION FOR ",
        _ => throw new InvalidOperationException("Unknown permission state " + state)
    };
    /// <summary>The tail after the grantee: WITH GRANT OPTION for withGrant, CASCADE where it is asked for and always after REVOKE GRANT
    /// OPTION FOR (SQL Server refuses to revoke or deny a grantable permission without it, 4611).</summary>
    private static string Tail(PermissionDto permission) => permission.State switch
    {
        "withGrant" => " WITH GRANT OPTION",
        "revokeGrantOption" => " CASCADE",
        "deny" or "revoke" when permission.Cascade == true => " CASCADE",
        _ => ""
    };
    /// <summary>Every keyword fragment a permission batch may hold besides the type's permissions and ON clause.</summary>
    internal static readonly IReadOnlySet<string> Fragments = new HashSet<string>(StringComparer.Ordinal)
    {
        "N'GRANT '", "N'DENY '", "N'REVOKE '", "N'REVOKE GRANT OPTION FOR '", "N' TO '", "N' WITH GRANT OPTION'", "N' CASCADE'"
    };
    /// <summary>The batch's other literals: the quoting guard's message and the module suffix.</summary>
    internal static readonly IReadOnlySet<string> Messages = new HashSet<string>(StringComparer.Ordinal) { "N'A name could not be quoted.'", "N'.sys.sp_executesql'" };

    // --- The builder --------------------------------------------------------------------------------------------------------

    /// <summary>The batch that runs one permission statement in master: @db (master), @p1 the login, @p2 the securable's name (none for
    /// the server). <paramref name="dryRun"/> (the live checks only, never the wire) selects the statement instead of running it.</summary>
    public static string Executable(SecurableCatalog catalog, PermissionDto permission, bool dryRun = false)
    {
        var spec = catalog.Type(permission.Securable.Type) ?? throw new InvalidOperationException("Unknown securable type.");
        if (!catalog.Takes(spec.Type, permission.Permission)) throw new InvalidOperationException("Not a permission of the securable's class.");
        var build = new StringBuilder("DECLARE @stmt nvarchar(max) = N'").Append(Verb(permission.State)).Append("' + N'").Append(permission.Permission).Append('\'');
        if (spec.On is { } on) build.Append(" + N'").Append(on).Append("' + QUOTENAME(@p2)");
        build.Append(" + N' TO ' + QUOTENAME(@p1)");
        if (Tail(permission) is { Length: > 0 } tail) build.Append(" + N'").Append(tail).Append('\'');
        build.Append(";\n").Append(ActionSql.Guard);
        build.Append(dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");
        return build.ToString();
    }

    /// <summary>The statement as SMO's SecurableUtils writes it (D2 §3.4, captured: GRANT VIEW SERVER STATE TO [l], … WITH GRANT OPTION,
    /// DENY SHUTDOWN TO [l], REVOKE … TO [l], REVOKE GRANT OPTION FOR … TO [l] CASCADE), names quoted by C#'s QUOTENAME. SMO's
    /// trailing space after WITH GRANT OPTION is left out.</summary>
    public static string Statement(SecurableCatalog catalog, string login, PermissionDto permission)
    {
        var spec = catalog.Type(permission.Securable.Type) ?? throw new InvalidOperationException("Unknown securable type.");
        var text = new StringBuilder(Verb(permission.State)).Append(permission.Permission);
        if (spec.On is { } on) text.Append(on).Append(ActionSql.Quote(permission.Securable.Name!));
        return text.Append(" TO ").Append(ActionSql.Quote(login)).Append(Tail(permission)).ToString();
    }

    /// <summary>The statements in the order they run, after User Mapping's (SSMS's last step, D2 §0): by type in the catalogue's order
    /// (the server first), then by securable name and permission.</summary>
    public static List<PermissionDto> Ordered(SecurableCatalog catalog, IEnumerable<PermissionDto> permissions) =>
        [.. permissions.OrderBy(permission => catalog.Order(permission.Securable.Type)).ThenBy(permission => permission.Securable.Name ?? "", StringComparer.OrdinalIgnoreCase)
            .ThenBy(permission => permission.Securable.Name ?? "", StringComparer.Ordinal).ThenBy(permission => permission.Permission, StringComparer.Ordinal)];

    public const string GrantStep = "Grant a permission";
    public const string DenyStep = "Deny a permission";
    public const string RevokeStep = "Revoke a permission";
    public const string RevokeGrantOptionStep = "Revoke a grant option";
    public static string StepTitle(PermissionDto permission) => permission.State switch
    {
        "grant" or "withGrant" => GrantStep,
        "deny" => DenyStep,
        "revokeGrantOption" => RevokeGrantOptionStep,
        _ => RevokeStep
    };
    /// <summary>The permission, and the securable it is on unless that is the server.</summary>
    public static string StepDetail(PermissionDto permission) => permission.Permission + (permission.Securable.Name is { } name ? " on " + ScriptingErrors.Display(name) : "");
    public static bool IsStep(string title) => title is GrantStep or DenyStep or RevokeStep or RevokeGrantOptionStep;

    /// <summary>Why a request's permissions are invalid (a member name, never a value), or null: at most <paramref name="limit"/>; each a
    /// known type with a name of 1–128 UTF-16 units exactly when it is not the server, a permission of its class that no other page owns,
    /// a known state (only grant, withGrant and deny when <paramref name="create"/>: a new login has nothing to revoke), CASCADE only
    /// with deny or revoke (and never when creating); each securable's permission at most once.</summary>
    public static string? Problem(SecurableCatalog catalog, IReadOnlyList<PermissionDto?>? permissions, bool create, long limit)
    {
        if (permissions is null) return null;
        if (permissions.Count > limit) return "permissions.";
        var seen = new HashSet<(string, string, string)>();
        foreach (var permission in permissions)
        {
            if (permission?.Securable is not { } securable || catalog.Type(securable.Type) is null) return "permissions.securable.";
            if (securable.Type == "server" ? securable.Name is not null : !ExplorerRefs.Ident(securable.Name)) return "permissions.securable.";
            if (!catalog.Takes(securable.Type, permission.Permission) || catalog.Reserved(securable.Type, permission.Permission)) return "permissions.permission.";
            var states = create ? new[] { "grant", "withGrant", "deny" } : new[] { "grant", "withGrant", "deny", "revoke", "revokeGrantOption" };
            if (!states.Contains(permission.State)) return "permissions.state.";
            if (permission.Cascade is not null && (create || permission.Cascade != true || permission.State is not ("deny" or "revoke"))) return "permissions.cascade.";
            if (!seen.Add((securable.Type, securable.Name ?? "", permission.Permission))) return "permissions: a permission twice.";
        }
        return null;
    }

    // --- Reads --------------------------------------------------------------------------------------------------------------

    /// <summary>New Login's Securables lists, in master: the server's name, every permission sys.fn_builtin_permissions lists (C# keeps the
    /// catalogue's that this server knows), then at most @take endpoints, logins, user-defined server roles (fixed roles and public are not
    /// securables, 15151) and availability groups, by name (the caller reads one more, so a truncation shows).</summary>
    public const string Describe = "SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')) AS server_name;\n"
        + "SELECT b.class_desc AS class_desc, b.permission_name AS permission_name FROM sys.fn_builtin_permissions(DEFAULT) AS b;\n"
        + "SELECT TOP (@take) e.name AS name FROM sys.endpoints AS e ORDER BY e.name;\n"
        + "SELECT TOP (@take) p.name AS name FROM sys.server_principals AS p WHERE p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY p.name;\n"
        + "SELECT TOP (@take) p.name AS name FROM sys.server_principals AS p WHERE p.type = 'R' AND p.is_fixed_role = 0 AND p.principal_id <> 2 ORDER BY p.name;\n"
        + "SELECT TOP (@take) g.name AS name FROM sys.availability_groups AS g ORDER BY g.name;";
    /// <summary>The named types in the order <see cref="Describe"/> lists their objects.</summary>
    public static readonly IReadOnlyList<string> DescribeOrder = ["endpoint", "login", "serverRole", "availabilityGroup"];

    /// <summary>Login Properties' read of the login's explicit permissions, in master, by the principal_id the login preflight found: at
    /// most @take rows of sys.server_permissions on the server (class 100), a login or server role (101, told apart by its type), an
    /// endpoint (105) or an availability group (108; its major_id taken as the local replica's metadata id, unverified without one), with
    /// the grantor's name. A row whose securable no longer resolves is left out by the caller.</summary>
    public const string Explicit = "SELECT TOP (@take) sp.class AS class, s.type AS principal_type, CASE sp.class WHEN 105 THEN e.name WHEN 101 THEN s.name WHEN 108 THEN ag.name END AS securable_name, "
        + "sp.permission_name AS permission_name, sp.state AS state, g.name AS grantor FROM sys.server_permissions AS sp "
        + "LEFT JOIN sys.server_principals AS g ON g.principal_id = sp.grantor_principal_id "
        + "LEFT JOIN sys.endpoints AS e ON sp.class = 105 AND e.endpoint_id = sp.major_id "
        + "LEFT JOIN sys.server_principals AS s ON sp.class = 101 AND s.principal_id = sp.major_id "
        + "LEFT JOIN sys.availability_replicas AS ar ON sp.class = 108 AND ar.replica_metadata_id = sp.major_id "
        + "LEFT JOIN sys.availability_groups AS ag ON ag.group_id = ar.group_id "
        + "WHERE sp.grantee_principal_id = @principal AND sp.class IN (100, 101, 105, 108) AND sp.state IN ('G', 'W', 'D') ORDER BY sp.class, securable_name, sp.permission_name;";

    /// <summary>The Effective tab's read (the loginEffectivePermissions describe): as the login (@name; EXECUTE AS LOGIN needs IMPERSONATE),
    /// at most @take permissions sys.fn_my_permissions lists on @securable (NULL for the server) of @class, by name; REVERT on success and
    /// on failure. It runs on the describe's own unpooled connection, which closes after the request, so no context can outlive it.</summary>
    public const string Effective = "EXECUTE AS LOGIN = @name;\nBEGIN TRY\n"
        + "SELECT TOP (@take) f.permission_name AS permission_name FROM sys.fn_my_permissions(@securable, @class) AS f ORDER BY f.permission_name;\n"
        + "END TRY\nBEGIN CATCH\nREVERT;\nTHROW;\nEND CATCH;\nREVERT;";

    // --- Lint ---------------------------------------------------------------------------------------------------------------

    [GeneratedRegex(@"N'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();

    private static int Count(string text, string part)
    {
        var count = 0;
        for (var index = text.IndexOf(part, StringComparison.Ordinal); index >= 0; index = text.IndexOf(part, index + part.Length, StringComparison.Ordinal)) count++;
        return count;
    }

    /// <summary>Problems with one permission batch of <paramref name="type"/> (empty when it passes): whatever ActionSql.LintExecutable's
    /// builder form finds (a format hole, a secret, a parameter outside QUOTENAME, an undeclared variable, no quoting guard, a literal
    /// that is not keyword text), then a literal that is neither one of <see cref="Fragments"/> or <see cref="Messages"/>, the type's ON
    /// clause, nor one of its catalogue permissions; not exactly one verb first and one permission after it; @p2 without the type's ON
    /// clause or the ON clause without @p2; and not exactly one EXEC @module @stmt (or the dry run's SELECT).</summary>
    public static List<string> LintExecutable(string text, SecurableCatalog catalog, string type)
    {
        var problems = ActionSql.LintExecutable(text, Messages);
        var spec = catalog.Type(type);
        if (spec is null) { problems.Add("names an unknown securable type"); return problems; }
        var literals = LiteralPattern().Matches(text).Select(match => match.Value).ToList();
        var permissions = literals.Count(literal => spec.Permissions.Any(permission => literal == "N'" + permission + "'"));
        foreach (var literal in literals)
            if (!Fragments.Contains(literal) && !Messages.Contains(literal) && literal != "N'" + spec.On + "'" && !spec.Permissions.Any(permission => literal == "N'" + permission + "'"))
                problems.Add("has the literal " + literal);
        if (permissions != 1) problems.Add("holds " + permissions + " permissions");
        if (!Regex.IsMatch(text, @"^DECLARE @stmt nvarchar\(max\) = N'(?:GRANT |DENY |REVOKE |REVOKE GRANT OPTION FOR )' \+ N'[A-Z ]+'")) problems.Add("does not start with one verb and its permission");
        var on = spec.On is null ? 0 : Count(text, "N'" + spec.On + "' + QUOTENAME(@p2)");
        if ((spec.On is null) != (on == 0) || on > 1 || Count(text, "@p2") != on) problems.Add("does not name the securable exactly once, through its ON clause");
        if (Count(text, " + N' TO ' + QUOTENAME(@p1)") != 1 || Count(text, "@p1") != 1) problems.Add("does not name the grantee exactly once");
        var runs = Count(text, "EXEC @module @stmt;") + Count(text, "SELECT @stmt AS stmt;");
        if (runs != 1 || Regex.Matches(text, @"\bEXEC(?:UTE)?\b", RegexOptions.IgnoreCase).Count != Count(text, "EXEC @module @stmt;")) problems.Add("does not run exactly one EXEC @module @stmt");
        return problems;
    }

    /// <summary>Every permission batch the builder can write: per type, each of its permissions with each statement form (CASCADE where it
    /// may go), run and dry run, one entry per type, form and run with every permission's problems; and the three reads.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint(SecurableCatalog catalog)
    {
        foreach (var type in catalog.Types)
            foreach (var (state, cascade) in Forms)
                foreach (var dry in new[] { false, true })
                {
                    var problems = new List<string>();
                    foreach (var permission in type.Permissions)
                    {
                        var choice = new PermissionDto(new(type.Type, type.Type == "server" ? null : "x"), permission, state, cascade);
                        problems.AddRange(LintExecutable(Executable(catalog, choice, dry), catalog, type.Type).Select(problem => permission + ": " + problem));
                    }
                    yield return ("permission " + type.Type + " " + state + (cascade == true ? " cascade" : "") + (dry ? " (dry run)" : ""), problems);
                }
        yield return ("securables describe", ActionSql.LintCatalog(Describe, ExplorerCatalog.MaxBand, database: false));
        yield return ("explicit permissions", ActionSql.LintCatalog(Explicit, ExplorerCatalog.MaxBand, database: false));
        yield return ("effective permissions", ActionSql.LintCatalog(Effective, ExplorerCatalog.MaxBand, database: false));
    }

    /// <summary>Each statement form: the five states, and DENY and REVOKE with CASCADE.</summary>
    internal static readonly IReadOnlyList<(string State, bool? Cascade)> Forms =
        [("grant", null), ("withGrant", null), ("deny", null), ("deny", true), ("revoke", null), ("revoke", true), ("revokeGrantOption", null)];
}
