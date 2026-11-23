using System.Text.RegularExpressions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Actions;

/// <summary>
/// The proxy and credential documents' SQL outside msdb's procedures (AG-8b): their describes' reads (constant catalogue SELECTs under
/// ActionSql.LintCatalog) and the CREATE CREDENTIAL and ALTER CREDENTIAL builder. A credential takes its identity and secret only as
/// literals, so SQL Server builds the statement from constant text, as New Login's CREATE LOGIN does (<see cref="LoginSql"/>): the name
/// through QUOTENAME, the identity and the secret each as one nvarchar(max) parameter, read once behind its NULL guard and quoted by a
/// binary-collation REPLACE. The statement is built as nvarchar(max) from its first operand, so a 4,000-character secret (or a 128-character identity) is never
/// cut. ALTER CREDENTIAL always sends both: without a SECRET it would clear the stored one. No batch returns, logs or passes on the secret.
/// </summary>
internal static partial class CredentialSql
{
    /// <summary>The batch refuses to run without its identity or secret rather than store a NULL one.</summary>
    internal const string IdentityGuard = "IF @identity IS NULL THROW 50000, N'The identity is missing.', 1;\n";
    internal const string SecretGuard = "IF @secret IS NULL THROW 50000, N'The secret is missing.', 1;\n";
    /// <summary>The only form the identity and secret may take: WITH IDENTITY = N'…', SECRET = N'…', their quotes doubled on the server.</summary>
    internal const string Clauses = " + N' WITH IDENTITY = N''' + REPLACE(@identity COLLATE Latin1_General_BIN2, N'''', N'''''') + N''', SECRET = N''' + REPLACE(@secret COLLATE Latin1_General_BIN2, N'''', N'''''') + N''''";
    /// <summary>An existing credential's STALE guard: still this credential_id under this name, unchanged since the document read its modify_date.</summary>
    internal const string StaleGuard = "IF NOT EXISTS (SELECT 1 FROM sys.credentials AS c WHERE c.credential_id = @credential_id AND c.name = @p1 AND c.modify_date = @modified) THROW 50011, N'"
        + Agent.AgentSql.StaleMessage + "', 1;\n";
    /// <summary>Script's stand-in: unquoted, so a script run unedited fails to parse and creates nothing.</summary>
    public const string Placeholder = "<secret>";

    // --- Reads ------------------------------------------------------------------------------------------------------------

    /// <summary>The proxy document's facts, for every login: whether it is sysadmin (proxies are sysadmin's alone) and may create credentials.</summary>
    public const string ProxyFacts = "SELECT CONVERT(bit, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)) AS sysadmin, CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY CREDENTIAL'), 0)) AS can_alter;";

    /// <summary>The proxy document's read (sysadmin): the proxy named @name (none for New Proxy, @name NULL) with its credential, the subsystems
    /// a proxy can be active to (every one but TSQL, id 1), those it is, the principals that may use it (sysproxylogin's flags: 0 a login, 1 a
    /// fixed server role, 2 an msdb role), the credentials, the principals the picker offers and the job steps that run as it. Each list reads
    /// one more row than it shows, so a truncation shows.</summary>
    public const string ProxyRead =
        "SELECT p.proxy_id AS id, p.name AS name, p.enabled AS enabled, p.description AS description, c.name AS credential, c.credential_identity AS credential_identity "
        + "FROM msdb.dbo.sysproxies AS p LEFT JOIN sys.credentials AS c ON c.credential_id = p.credential_id WHERE p.name = @name;\n"
        + "SELECT s.subsystem_id AS id, s.subsystem AS name FROM msdb.dbo.syssubsystems AS s WHERE s.subsystem_id > 1 ORDER BY s.subsystem_id;\n"
        + "SELECT ps.subsystem_id AS id FROM msdb.dbo.sysproxysubsystem AS ps JOIN msdb.dbo.sysproxies AS p ON p.proxy_id = ps.proxy_id WHERE p.name = @name;\n"
        + "SELECT TOP (@principals) COALESCE(sp.name, dp.name) AS name, pl.flags AS flags FROM msdb.dbo.sysproxylogin AS pl JOIN msdb.dbo.sysproxies AS p ON p.proxy_id = pl.proxy_id "
        + "LEFT JOIN sys.server_principals AS sp ON pl.flags IN (0, 1) AND sp.sid = pl.sid LEFT JOIN msdb.sys.database_principals AS dp ON pl.flags = 2 AND dp.sid = pl.sid "
        + "WHERE p.name = @name AND COALESCE(sp.name, dp.name) IS NOT NULL ORDER BY flags, name;\n"
        + "SELECT TOP (@credentials) c.name AS name, c.credential_identity AS credential_identity FROM sys.credentials AS c ORDER BY c.name;\n"
        + "SELECT TOP (@choices) x.name AS name, x.flags AS flags FROM (SELECT sp.name AS name, CASE WHEN sp.type = 'R' THEN 1 ELSE 0 END AS flags FROM sys.server_principals AS sp "
        + "WHERE (sp.type IN ('S', 'U', 'G', 'E', 'X') OR (sp.type = 'R' AND sp.is_fixed_role = 1)) AND sp.name NOT LIKE N'##%' "
        + "UNION ALL SELECT dp.name, 2 FROM msdb.sys.database_principals AS dp WHERE dp.type = 'R' AND dp.principal_id > 0) AS x ORDER BY x.flags, x.name;\n"
        + "SELECT TOP (@references) j.name AS job, st.step_id AS step_id, st.step_name AS step, st.subsystem AS subsystem FROM msdb.dbo.sysjobsteps AS st "
        + "JOIN msdb.dbo.sysjobs AS j ON j.job_id = st.job_id JOIN msdb.dbo.sysproxies AS p ON p.proxy_id = st.proxy_id WHERE p.name = @name ORDER BY j.name, st.step_id;";

    /// <summary>A proxy by name, for Delete Object (sysadmin): its immutable proxy_id, which the Delete request names.</summary>
    public const string ProxyByName = "SELECT p.proxy_id AS id, p.name AS name FROM msdb.dbo.sysproxies AS p WHERE p.name = @name;";

    /// <summary>The credential document's read: the login's facts, the credential named @name (none for New Credential) with an EKM
    /// credential's provider and its dates (modify_date, to the millisecond, is the STALE guard's), and the enabled cryptographic providers.</summary>
    public const string CredentialRead =
        "SELECT CONVERT(bit, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)) AS sysadmin, CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY CREDENTIAL'), 0)) AS can_alter;\n"
        + "SELECT c.credential_id AS id, c.name AS name, c.credential_identity AS credential_identity, c.create_date AS created, c.modify_date AS modified, cp.name AS provider FROM sys.credentials AS c "
        + "LEFT JOIN sys.cryptographic_providers AS cp ON c.target_type = N'CRYPTOGRAPHIC PROVIDER' AND cp.provider_id = c.target_id WHERE c.name = @name;\n"
        + "SELECT TOP (@providers) cp.name AS name FROM sys.cryptographic_providers AS cp WHERE cp.is_enabled = 1 ORDER BY cp.name;";

    /// <summary>Used by (sysadmin): the proxies that run as credential @credential_id, the subsystems each is active to, and the job steps
    /// that run as them.</summary>
    public const string CredentialUsedBy =
        "SELECT TOP (@proxies) p.proxy_id AS id, p.name AS name FROM msdb.dbo.sysproxies AS p WHERE p.credential_id = @credential_id ORDER BY p.name;\n"
        + "SELECT ps.proxy_id AS id, s.subsystem AS name FROM msdb.dbo.sysproxysubsystem AS ps JOIN msdb.dbo.syssubsystems AS s ON s.subsystem_id = ps.subsystem_id "
        + "JOIN msdb.dbo.sysproxies AS p ON p.proxy_id = ps.proxy_id WHERE p.credential_id = @credential_id ORDER BY ps.proxy_id, s.subsystem_id;\n"
        + "SELECT TOP (@references) st.proxy_id AS id, j.name AS job, st.step_id AS step_id, st.step_name AS step FROM msdb.dbo.sysjobsteps AS st "
        + "JOIN msdb.dbo.sysjobs AS j ON j.job_id = st.job_id JOIN msdb.dbo.sysproxies AS p ON p.proxy_id = st.proxy_id WHERE p.credential_id = @credential_id ORDER BY j.name, st.step_id;";

    /// <summary>Every read above with its LintCatalog problems (ActionSql.Lint).</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintReads()
    {
        foreach (var (name, text) in new[] { ("proxy facts", ProxyFacts), ("proxy read", ProxyRead), ("proxy by name", ProxyByName), ("credential read", CredentialRead), ("credential used by", CredentialUsedBy) })
            yield return (name, ActionSql.LintCatalog(text, ExplorerCatalog.MaxBand, database: false));
    }

    // --- CREATE CREDENTIAL and ALTER CREDENTIAL ---------------------------------------------------------------------------

    /// <summary>The statement's builder and runner, after the guards: @p1 the credential, @p2 a New Credential's provider, @db the database whose
    /// sp_executesql runs it (master).</summary>
    public static string Statement(bool create, bool provider) =>
        "DECLARE @stmt nvarchar(max) = CONVERT(nvarchar(max), N'" + (create ? "CREATE" : "ALTER") + " CREDENTIAL ') + QUOTENAME(@p1)" + Clauses
        + (provider ? " + N' FOR CRYPTOGRAPHIC PROVIDER ' + QUOTENAME(@p2)" : "") + ";\n" + ActionSql.Guard
        + "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;";

    /// <summary>The credential document's batch: the guards, an existing credential's STALE guard, then the statement.</summary>
    public static string Executable(bool create, bool provider) => IdentityGuard + SecretGuard + (create ? "" : StaleGuard) + Statement(create, provider);

    /// <summary>The block a proxy save opens with when it creates its credential (Agent.AgentSql.ProxySave).</summary>
    public static string ProxyBlock => IdentityGuard + SecretGuard + Statement(create: true, provider: false) + "\n";

    /// <summary>The statement as Script writes it: the name and provider quoted by C#'s QUOTENAME, the identity a literal, the secret
    /// <see cref="Placeholder"/>.</summary>
    public static string ScriptStatement(bool create, string name, string identity, string? provider) =>
        (create ? "CREATE" : "ALTER") + " CREDENTIAL " + ActionSql.Quote(name) + " WITH IDENTITY = N'" + identity.Replace("'", "''", StringComparison.Ordinal) + "', SECRET = " + Placeholder
        + (provider is null ? "" : " FOR CRYPTOGRAPHIC PROVIDER " + ActionSql.Quote(provider));

    /// <summary>The keyword text a credential batch holds besides its guards' messages and the clauses' own delimiters.</summary>
    private static readonly IReadOnlySet<string> Fragments = new HashSet<string>(["N'CREATE CREDENTIAL '", "N'ALTER CREDENTIAL '", "N' FOR CRYPTOGRAPHIC PROVIDER '"], StringComparer.Ordinal);
    private static readonly IReadOnlySet<string> Messages = new HashSet<string>(StringComparer.Ordinal)
    {
        "N'The identity is missing.'", "N'The secret is missing.'", "N'A name could not be quoted.'", "N'.sys.sp_executesql'", "N'" + Agent.AgentSql.StaleMessage + "'"
    };

    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();
    /// <summary>Names through QUOTENAME (@p1, @p2), and the database only as the module it runs.</summary>
    [GeneratedRegex(@"QUOTENAME\(@p[12]\)|QUOTENAME\(@db\) \+ N'\.sys\.sp_executesql'")]
    private static partial Regex NameUse();
    [GeneratedRegex(@"\bEXEC(?:UTE)?\b", RegexOptions.IgnoreCase)]
    private static partial Regex Exec();
    [GeneratedRegex(@"\b(?:SID|HASHED|ROLLBACK|DROP|STRING_AGG|OPENROWSET|OPENQUERY|OPENDATASOURCE|PRINT|SELECT\s+@)\b|xp_|EXEC\s*\(", RegexOptions.IgnoreCase)]
    private static partial Regex Banned();

    private static int Count(string text, string part)
    {
        var count = 0;
        for (var index = text.IndexOf(part, StringComparison.Ordinal); index >= 0; index = text.IndexOf(part, index + part.Length, StringComparison.Ordinal)) count++;
        return count;
    }

    /// <summary>Problems with one credential batch (empty when it passes): a format hole or a secret use any lint refuses; no quoting guard;
    /// not opening with the identity's and the secret's NULL guards; @identity or @secret other than exactly twice (its guard, then once in
    /// <see cref="Clauses"/>, which appears once), so no inner batch receives either and nothing returns them; a name outside QUOTENAME or @db
    /// outside the module; any variable but the statement's own, the STALE guard's (only in <see cref="StaleGuard"/>, at most once); a literal
    /// that is neither keyword text nor a guard message; not exactly one EXEC @module @stmt; and a banned word. <paramref name="text"/> may be
    /// a proxy save's credential block (<see cref="ProxyBlock"/>), which runs inside its batch.</summary>
    public static List<string> LintExecutable(string text)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        problems.AddRange(CatalogSql.SecretUses(text));
        if (!text.Contains(ActionSql.Guard, StringComparison.Ordinal)) problems.Add("has no quoting guard");
        if (!text.StartsWith(IdentityGuard + SecretGuard, StringComparison.Ordinal)) problems.Add("does not check @identity and @secret for NULL first");
        if (Count(text, Clauses) != 1) problems.Add("does not quote @identity and @secret exactly once through the binary-collation REPLACE");
        foreach (var secret in new[] { "@identity", "@secret" })
            if (Count(text, secret) != 2) problems.Add("uses " + secret + " " + Count(text, secret) + " times");
        if (Count(text, StaleGuard) > 1) problems.Add("guards the credential more than once");
        var rest = text.Replace(IdentityGuard, "", StringComparison.Ordinal).Replace(SecretGuard, "", StringComparison.Ordinal).Replace(Clauses, "", StringComparison.Ordinal)
            .Replace(StaleGuard, "", StringComparison.Ordinal);
        foreach (Match used in Variable().Matches(NameUse().Replace(rest, "")))
            if (used.Value is not ("@stmt" or "@module")) problems.Add("uses " + used.Value + " outside QUOTENAME and its guards");
        if (Count(text, "EXEC @module @stmt;") != 1 || Exec().Matches(text).Count != 1) problems.Add("does not run exactly one EXEC @module @stmt");
        if (Banned().IsMatch(rest)) problems.Add("has a banned word: " + Banned().Match(rest).Value);
        foreach (Match literal in LiteralPattern().Matches(rest))
            if (!Messages.Contains(literal.Value) && !(Fragments.Contains(literal.Value) && LoginSql.KeywordLiteral().IsMatch(literal.Value))) problems.Add("has the literal " + literal.Value);
        return problems;
    }

    /// <summary>Every credential batch the builder writes (New Credential with and without a provider, an existing credential's ALTER, a proxy
    /// save's block) with its lint problems (ActionSql.Lint), and the documents' reads.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint()
    {
        foreach (var provider in new[] { false, true }) yield return ("create credential" + (provider ? " with a provider" : ""), LintExecutable(Executable(true, provider)));
        yield return ("alter credential", LintExecutable(Executable(false, false)));
        yield return ("proxy credential block", LintExecutable(ProxyBlock));
        foreach (var item in LintReads()) yield return ("credential " + item.Name, item.Problems);
    }

    /// <summary>A message with the secret replaced by <see cref="Placeholder"/>, quoted or not (as LoginSql.Scrub does for passwords).</summary>
    public static string Scrub(string text, string? secret)
    {
        if (string.IsNullOrEmpty(secret)) return text;
        foreach (var form in new[] { secret.Replace("'", "''", StringComparison.Ordinal), secret }.Distinct(StringComparer.Ordinal))
        {
            text = text.Replace("'" + form + "'", "'" + Placeholder + "'", StringComparison.Ordinal).Replace("\"" + form + "\"", "\"" + Placeholder + "\"", StringComparison.Ordinal);
            if (secret.Length >= LoginSql.BareSecretLength) text = text.Replace(form, Placeholder, StringComparison.Ordinal);
        }
        return text;
    }
}
