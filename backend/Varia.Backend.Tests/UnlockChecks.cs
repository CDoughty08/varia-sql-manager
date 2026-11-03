using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of Unlock Login (D4d): the CHECK_POLICY templates and their transaction's script, the plan by the
/// login's expiration, LoginLock's LOGINPROPERTY allowlist and its lint, the refusals from the facts and the lock-out state,
/// validation parity with zod (the wire's `mode`), the error map, and the engine gate before any connection.</summary>
internal static class UnlockChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly string NL = Environment.NewLine;
    private static string Id() => Guid.NewGuid().ToString();
    private static readonly ObjectRefDto Locked = new("login", Name: "Locked");
    private static readonly LoginIdentityDto Identity = new("01", "2026-01-01T00:00:00.000");
    private static ActionArgs Unlock(ObjectRefDto target) => new("unlock", Id(), Id(), target, Mode: "keepPassword");
    private static LoginFactsDto Facts(string subtype = "sql", string type = "S", bool? policy = true, bool own = false, bool canAlter = true, bool sysadmin = false, bool controlServer = true) =>
        new(300, type, subtype, false, "01", "2026-01-01T00:00:00.000", policy, true, false, own, sysadmin, 0, null, [], null, canAlter, controlServer, false);
    private static LoginLockFactsDto Lock(bool locked = true, bool mustChange = false) => new(locked, locked ? 11 : 0, locked ? "2026-11-02T21:07:12.123" : null, mustChange, false, 42);

    public static async Task RunAsync(Action<bool, string> check)
    {
        Templates(check);
        LoginLockLint(check);
        Refusals(check);
        Validation(check);
        Errors(check);
        await ServiceAsync(check);
    }

    private static void Templates(Action<bool, string> check)
    {
        check(ActionSql.Statement(new(ActionTemplate.CheckPolicyOff, "master", ["App]User"])) == "ALTER LOGIN [App]]User] WITH CHECK_POLICY = OFF"
            && ActionSql.Statement(new(ActionTemplate.CheckPolicyOn, "master", ["AppUser"])) == "ALTER LOGIN [AppUser] WITH CHECK_POLICY = ON"
            && ActionSql.Statement(new(ActionTemplate.CheckPolicyExpirationOn, "master", ["AppUser"])) == "ALTER LOGIN [AppUser] WITH CHECK_POLICY = ON, CHECK_EXPIRATION = ON",
            "Unlock's statements turn the password policy off, then on, with expiration when the login had it (D4 P12, P13)");
        // One statement per template, its single name quoted by SQL Server; the lint refuses the name outside QUOTENAME.
        var templates = new[] { ActionTemplate.CheckPolicyOff, ActionTemplate.CheckPolicyOn, ActionTemplate.CheckPolicyExpirationOn };
        check(templates.All(template => ActionSql.ParameterCount(template) == 1 && ActionSql.LintExecutable(ActionSql.Executable(template), template).Count == 0
                && ActionSql.Executable(template).Contains("N'ALTER LOGIN ' + QUOTENAME(@p1) + N' WITH CHECK_POLICY = ", StringComparison.Ordinal)
                && ActionSql.LintExecutable(ActionSql.Executable(template).Replace("QUOTENAME(@p1)", "@p1", StringComparison.Ordinal), template).Count > 0
                && ActionSql.LintExecutable(ActionSql.Executable(template).Replace("CHECK_POLICY = ", "CHECK_POLICY = OFF, PASSWORD = ", StringComparison.Ordinal), template).Count > 0),
            "Unlock's batches have SQL Server quote the login's name and pass the lint, which refuses a bare name or any other literal");
        check(ActionService.UnlockPlan("AppUser", expiration: false).Select(plan => plan.Template).SequenceEqual([ActionTemplate.CheckPolicyOff, ActionTemplate.CheckPolicyOn])
            && ActionService.UnlockPlan("AppUser", expiration: true).Select(plan => plan.Template).SequenceEqual([ActionTemplate.CheckPolicyOff, ActionTemplate.CheckPolicyExpirationOn])
            && ActionService.UnlockPlan("AppUser", true).All(plan => plan.Database == "master" && plan.Names.SequenceEqual(["AppUser"]) && plan.Kind == StepKind.Main)
            && ActionService.StepTitle(ActionTemplate.CheckPolicyOff) == "Turn off the password policy" && ActionService.StepTitle(ActionTemplate.CheckPolicyOn) == "Turn the password policy back on"
            && ActionService.StepTitle(ActionTemplate.CheckPolicyExpirationOn) == "Turn the password policy and expiration back on",
            "Unlock plans its two statements in master by the login's expiration, with step titles of at most 64 characters");
        check(ActionSql.TransactionScriptText(ActionService.UnlockPlan("App]User", true)) == "USE [master]" + NL + "GO" + NL + "SET XACT_ABORT ON;" + NL + "BEGIN TRANSACTION;" + NL
                + "ALTER LOGIN [App]]User] WITH CHECK_POLICY = OFF;" + NL + "ALTER LOGIN [App]]User] WITH CHECK_POLICY = ON, CHECK_EXPIRATION = ON;" + NL + "COMMIT TRANSACTION;" + NL + "GO" + NL
            && SqlScript.Parse(ActionSql.TransactionScriptText(ActionService.UnlockPlan("AppUser", false))).Count == 2,
            "Unlock's script is one transaction in one batch after USE [master], so running it is as atomic as the action");
        var failures = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append("\\"))
        {
            var name = ActionChecks.Long(fragment);
            var text = ActionSql.TransactionScriptText(ActionService.UnlockPlan(name, true));
            if (SqlScript.Parse(text).Count != 2 || !text.Contains("ALTER LOGIN [" + name.Replace("]", "]]", StringComparison.Ordinal) + "] WITH CHECK_POLICY = OFF;", StringComparison.Ordinal)) failures.Add(fragment[..1]);
        }
        check(failures.Count == 0, "Unlock's script quotes hostile 128-unit names and stays two batches: " + string.Join(", ", failures));
        var refused = false;
        try { ActionSql.TransactionScriptText([new(ActionTemplate.CheckPolicyOff, "master", ["a"]), new(ActionTemplate.DropTable, "AppData", ["dbo", "t"])]); }
        catch (InvalidOperationException) { refused = true; }
        check(refused, "a transaction's script refuses statements in two databases, which one USE cannot cover");
        check(ActionSql.ReadPrologueOf(10_000) == ActionSql.ReadPrologue && ActionSql.ReadPrologueOf(250).EndsWith(" SET LOCK_TIMEOUT 250;", StringComparison.Ordinal)
            && ActionSql.ReadPrologueOf(250).StartsWith(ActionSql.ReadPrologue.Split(" SET LOCK_TIMEOUT", 2)[0], StringComparison.Ordinal) && new ActionServiceOptions().ReadLockTimeoutMs == 10_000
            && Catalog.Limit("readLockTimeoutMs") == 10_000, "the read prologue's lock timeout is the catalogue's, and only the live checks shorten it");
    }

    private static void LoginLockLint(Action<bool, string> check)
    {
        var lint = ActionSql.Lint().ToList();
        check(lint.Single(result => result.Name == "login lock").Problems.Count == 0 && ActionSql.LintLoginLock(ActionSql.LoginLock).Count == 0
            && ActionSql.LintCatalog(ActionSql.LoginLock, ExplorerCatalog.MaxBand, database: false).Count > 0,
            "LoginLock passes its own lint, the only one that lets LOGINPROPERTY through, and every catalog lint refuses it");
        check(ActionSql.LoginLockProperties.SequenceEqual(Catalog.Logins.LockProperties) && !ActionSql.LoginLockProperties.Any(name => name.Contains("Hash", StringComparison.OrdinalIgnoreCase)),
            "LoginLock reads exactly the lock-out properties logins.ts allows, never a password hash");
        var mutants = new (string Name, string Text)[]
        {
            ("the password hash", ActionSql.LoginLock.Replace("N'IsExpired'", "N'PasswordHash'", StringComparison.Ordinal)),
            ("the hash algorithm", ActionSql.LoginLock.Replace("N'IsExpired'", "N'PasswordHashAlgorithm'", StringComparison.Ordinal)),
            ("another property", ActionSql.LoginLock.Replace("N'IsExpired'", "N'DefaultDatabase'", StringComparison.Ordinal)),
            ("another login", ActionSql.LoginLock.Replace("LOGINPROPERTY(@name, N'IsLocked')", "LOGINPROPERTY(@new, N'IsLocked')", StringComparison.Ordinal)),
            ("a space before the parenthesis", ActionSql.LoginLock.Replace("LOGINPROPERTY(@name, N'IsLocked')", "LOGINPROPERTY (@name, N'IsLocked')", StringComparison.Ordinal)),
            ("lower case", ActionSql.LoginLock.Replace("LOGINPROPERTY(@name, N'IsLocked')", "loginproperty(@name, N'IsLocked')", StringComparison.Ordinal)),
            ("a property from a variable", ActionSql.LoginLock.Replace("N'IsLocked'", "@take", StringComparison.Ordinal)),
            ("a password hash column", ActionSql.LoginLock.TrimEnd(';') + ", (SELECT TOP (1) l.password_hash FROM sys.sql_logins AS l ORDER BY l.name) AS h;"),
            ("a metadata function", ActionSql.LoginLock.TrimEnd(';') + ", SUSER_SNAME(0x01) AS n;"),
            ("no property at all", "SELECT CONVERT(int, NULL) AS is_locked;")
        };
        var missed = mutants.Where(mutant => ActionSql.LintLoginLock(mutant.Text).Count == 0).Select(mutant => mutant.Name).ToList();
        check(missed.Count == 0, "LoginLock's lint refuses any other property, login or form of the call, a password hash and metadata functions: " + string.Join(", ", missed));
        // The catalogue and the statement must agree, or the backend refuses to load (critic A15).
        using var embedded = typeof(ActionsCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Actions.actions-catalog.json")!;
        var json = System.Text.Json.Nodes.JsonNode.Parse(embedded)!.AsObject();
        json["logins"]!["lockProperties"]!.AsArray().Add("PasswordHash");
        var loaded = true;
        try { _ = ActionsCatalog.Parse(new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json.ToJsonString()))); }
        catch (Exception error) when (error is InvalidOperationException or ArgumentException) { loaded = false; }
        check(!loaded, "a catalogue whose lock-out properties differ from LoginLock's does not load");
    }

    private static void Refusals(Action<bool, string> check)
    {
        var cases = new (string Name, LoginFactsDto Facts, LoginLockFactsDto Lock, string? Execute, string? Script)[]
        {
            ("a locked login", Facts(), Lock(), null, null),
            ("one not locked", Facts(), Lock(locked: false), "notLocked", null),
            ("one without the policy", Facts(policy: false), Lock(), "unlockNoPolicy", "unlockNoPolicy"),
            ("a policy SQL Server did not read", Facts(policy: null), Lock(), "unlockNoPolicy", "unlockNoPolicy"),
            ("one that must change its password", Facts(), Lock(mustChange: true), "unlockMustChange", "unlockMustChange"),
            ("a Windows login", Facts("windowsUser", "U", policy: null), Lock(locked: false), "unlockNoPolicy", "unlockNoPolicy"),
            ("sa", Facts("sa"), Lock(), null, null)
        };
        var wrong = cases.Where(item => LoginRules.UnlockRefusal(item.Facts, item.Lock) != item.Execute || LoginRules.UnlockRefusal(item.Facts, item.Lock, script: true) != item.Script)
            .Select(item => item.Name).ToList();
        check(wrong.Count == 0, "Unlock keeps the password only for a locked SQL Server login with the policy that need not change its password; its script only skips the lock: " + string.Join(", ", wrong));
        check(Catalog.Logins.Message("notLocked") == "The login is not locked out." && Catalog.Logins.Message("unlockNoPolicy").Length > 0 && Catalog.Logins.Message("unlockMustChange").Contains("new password", StringComparison.Ordinal),
            "Unlock's refusals are the catalogue's messages");
        // The rules come first: SQL Server's own logins, permissions; the own login may unlock itself (it is not in ownRefuses).
        using var service = new ActionService(new ActionChecks.FakeHost());
        var rules = new (string Name, LoginFactsDto Facts, ActionArgs Args, string? Code)[]
        {
            ("a plain unlock", Facts(), Unlock(Locked), null),
            ("the own login", Facts(own: true), Unlock(Locked), null),
            ("SQL Server's own login", Facts("system"), Unlock(Locked), "NOT_SUPPORTED"),
            ("a Windows login", Facts("windowsUser", "U"), Unlock(Locked), "NOT_SUPPORTED"),
            ("no ALTER ANY LOGIN", Facts(canAlter: false), Unlock(Locked), "PERMISSION_DENIED"),
            ("a sysadmin without CONTROL SERVER", Facts(sysadmin: true, controlServer: false), Unlock(Locked), "PERMISSION_DENIED"),
            ("another login took the name", Facts(), Unlock(Locked) with { LoginIdentity = Identity with { Sid = "02" } }, "NOT_FOUND"),
            ("the login that was read", Facts(), Unlock(Locked) with { LoginIdentity = Identity }, null)
        };
        var misjudged = rules.Where(item => service.LoginRefusal(item.Facts, item.Args)?.Code != item.Code).Select(item => item.Name).ToList();
        check(misjudged.Count == 0, "Unlock's preflight applies the login rules and the identity before the lock-out state: " + string.Join(", ", misjudged));
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new ActionChecks.FakeHost());
        string Refused(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        string DescribeRefused(string dialog, ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Id(), Id(), dialog, target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var system = new ObjectRefDto("login", Name: "##MS_PolicyTsqlExecutionLogin##");
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("no mode", Unlock(Locked) with { Mode = null }), ("a new password mode", Unlock(Locked) with { Mode = "newPassword" }), ("a mode in another case", Unlock(Locked) with { Mode = "KeepPassword" }),
            ("a new name", Unlock(Locked) with { NewName = "x" }), ("delete flags", Unlock(Locked) with { CloseConnections = false, DeleteHistory = false }),
            ("changes", Unlock(Locked) with { Changes = new() }), ("a database identity", Unlock(Locked) with { Identity = new(1, "2026-01-01T00:00:00.000") }),
            ("a password", Unlock(Locked) with { Secrets = new("x", null) }), ("a table", Unlock(new ObjectRefDto("table", "AppData", "dbo", "Orders"))),
            ("a database", Unlock(new ObjectRefDto("database", Name: "AppData"))), ("SQL Server's own login", Unlock(system)), ("no name", Unlock(new ObjectRefDto("login"))),
            ("a bad SID", Unlock(Locked) with { LoginIdentity = Identity with { Sid = "0a" } }),
            ("a mode on a disable", new ActionArgs("disable", Id(), Id(), Locked, Mode: "keepPassword")), ("a mode on a rename", new ActionArgs("rename", Id(), Id(), Locked, "x", Mode: "keepPassword"))
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0, "Validate refuses what zod refuses for Unlock: " + string.Join(", ", accepted));
        check(Refused(Unlock(Locked)) == "accepted" && Refused(Unlock(Locked) with { LoginIdentity = Identity }) == "accepted" && Refused(Unlock(Locked), script: true) == "accepted"
            && Refused(Unlock(new ObjectRefDto("login", Name: @"CONTOSO\Ops"))) == "accepted",
            "Unlock with keepPassword, and the identity of the login it read, is accepted; the preflight judges the login's kind");
        check(DescribeRefused("unlockLogin", Locked) == "accepted" && DescribeRefused("unlockLogin", system) == "INVALID_PARAMS"
            && DescribeRefused("unlockLogin", new ObjectRefDto("table", "AppData", "dbo", "Orders")) == "INVALID_PARAMS" && DescribeRefused("unlocklogin", Locked) == "INVALID_PARAMS",
            "the unlockLogin describe takes only a login Unlock may act on");
        // The wire names the mode as zod does (`mode`), and the backend refuses members it does not know.
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
        var head = "{\"action\":\"unlock\",\"connectionId\":\"" + Id() + "\",\"requestId\":\"" + Id() + "\",\"target\":{\"kind\":\"login\",\"name\":\"Locked\"},";
        var parsed = JsonSerializer.Deserialize<ActionArgs>(head + "\"mode\":\"keepPassword\",\"loginIdentity\":{\"sid\":\"01\",\"created\":\"2026-01-01T00:00:00.000\"}}", options);
        var unknown = false;
        try { _ = JsonSerializer.Deserialize<ActionArgs>(head + "\"unlockMode\":\"keepPassword\"}", options); }
        catch (JsonException) { unknown = true; }
        check(parsed is { Mode: "keepPassword", LoginIdentity.Sid: "01" } && Refused(parsed) == "accepted" && unknown, "Unlock's request reads zod's `mode` and refuses any other spelling");
    }

    private static void Errors(Action<bool, string> check)
    {
        static SqlException Sql(int number) => ConnectionFailureChecks.Sql(number, 1, 16, "server", "failed");
        check(ActionErrors.CodeOf(Sql(15128), null) == "NOT_SUPPORTED" && ActionService.UnlockRolledBack.StartsWith("SQL Server rolled back the transaction", StringComparison.Ordinal),
            "SQL Server's refusal to turn off the policy of a login that must change its password is NOT_SUPPORTED, and a failed unlock says it was rolled back");
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        var host = new ActionChecks.FakeHost(5);
        using var cloud = new ActionService(host);
        var unlock = await cloud.ExecuteAsync(Unlock(Locked), CancellationToken.None);
        var script = await cloud.ScriptAsync(Unlock(Locked), CancellationToken.None);
        var describe = await cloud.DescribeAsync(new(Id(), Id(), "unlockLogin", Locked), CancellationToken.None);
        check(unlock.Error?.Code == "NOT_SUPPORTED" && script.Error?.Code == "NOT_SUPPORTED" && describe.Error?.Code == "NOT_SUPPORTED" && describe.Lock is null && host.Connections == 0,
            "Azure SQL Database answers Unlock, its script and its describe NOT_SUPPORTED before any connection opens");
        var unreachable = new ActionChecks.FakeHost();
        using var service = new ActionService(unreachable);
        var failed = await service.DescribeAsync(new(Id(), Id(), "unlockLogin", Locked), CancellationToken.None);
        check(failed.Error is not null && failed.Lock is null && failed.Login is null && unreachable.Connections == 1 && service.RunningCount == 0,
            "an unlockLogin describe that cannot connect answers an error value and frees its request");
    }
}
